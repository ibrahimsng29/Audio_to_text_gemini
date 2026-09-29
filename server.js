import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Dossier pour stocker les fichiers audio de façon pérenne sur le disque
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('✅ Connecté à MongoDB Atlas !'))
        .catch(err => console.error('❌ Erreur MongoDB :', err));
}

// Modèles MongoDB
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    dateCreation: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const transcriptionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, 
    titre: { type: String, default: 'Enregistrement' },
    texte: String,
    mode: String,
    audioUrl: String,
    audioPath: String,
    date: { type: Date, default: Date.now }
});
const Transcription = mongoose.model('Transcription', transcriptionSchema);

// 🛡️ Stockage sur disque pour 0 Mo de RAM consommée (Protection Render contre crash OOM)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname || '') || (file.mimetype.includes('webm') ? '.webm' : '.mp3');
        cb(null, `audio-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 Mo max
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error("Format non autorisé. Seul l'audio/vidéo est accepté."));
        }
    }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ==========================================
// 🛡️ LE VIGILE (Middleware de sécurité)
// ==========================================
const verifierToken = (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Accès refusé. Veuillez vous connecter." });
    }

    const token = authHeader.replace('Bearer ', '');
    try {
        const secret = process.env.JWT_SECRET || 'cle_secrete_provisoire_pour_le_dev';
        const utilisateurVerifie = jwt.verify(token, secret);
        req.user = utilisateurVerifie; 
        next(); 
    } catch (error) {
        res.status(403).json({ error: "Token invalide ou expiré." });
    }
};

// ==========================================
// 🔐 ROUTES D'AUTHENTIFICATION
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis." });

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: "Cet email est déjà utilisé." });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ email, password: hashedPassword });
        await newUser.save();

        res.status(201).json({ success: true, message: "Compte créé avec succès !" });
    } catch (error) {
        console.error("Erreur inscription :", error);
        res.status(500).json({ success: false, error: "Erreur lors de la création du compte." });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "Email ou mot de passe incorrect." });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Email ou mot de passe incorrect." });

        const tokenSecret = process.env.JWT_SECRET || 'cle_secrete_provisoire_pour_le_dev';
        const token = jwt.sign({ id: user._id, email: user.email }, tokenSecret, { expiresIn: '24h' });

        res.json({ success: true, token, email: user.email, message: "Connexion réussie !" });
    } catch (error) {
        console.error("Erreur connexion :", error);
        res.status(500).json({ success: false, error: "Erreur lors de la connexion." });
    }
});

// ==========================================
// 🎙️ ROUTES PROTÉGÉES DE L'APPLICATION
// ==========================================
app.get('/', (req, res) => {
    const publicIndexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(publicIndexPath)) {
        res.sendFile(publicIndexPath);
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

app.post('/transcrire', verifierToken, upload.single('audio'), async (req, res) => {
    let uploadedGeminiFile = null;
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "Aucun fichier audio reçu." });

        const mode = req.body?.mode || 'resume';
        const titreSource = req.body?.titreSource || 'Enregistrement audio';
        const mimeType = req.file.mimetype || 'audio/webm';
        const audioUrl = `/uploads/${req.file.filename}`;

        let instructionPrompt = "Transcris cet audio en français de manière claire et structurée, puis donne un résumé. Conserve fidèlement les termes techniques, acronymes et noms propres. Ignore les longs silences et les bruits parasites.";
        if (mode === 'cours') instructionPrompt = "Tu es un assistant universitaire expert. Transcris et synthétise ce cours académique. Structure le document avec :\n1. 📖 Plan structuré du cours\n2. 💡 Concepts-clés et définitions essentielles\n3. 📝 Synthèse détaillée des explications\n4. 🎯 Mini-quiz d'auto-évaluation (3 questions clés avec réponses pour réviser).\nConserve scrupuleusement les termes techniques et le jargon académique. Ignore les réverbérations de salle et les silences.";
        if (mode === 'reunion') instructionPrompt = "Tu es un secrétaire de séance professionnel. Transcris et synthétise cette réunion de travail. Structure le document avec :\n1. 🎯 Ordre du jour et objectifs\n2. 📋 Synthèse des échanges clés\n3. ✅ Décisions actées\n4. 🚀 Matrice d'actions (To-Do) : [Tâche | Responsable | Échéance estimée].\nIgnore les silences, hésitations et réverbérations de pièce.";
        if (mode === 'bullet') instructionPrompt = "Transcris cet audio et fais un résumé clair sous forme de puces. Conserve fidèlement le vocabulaire technique.";
        if (mode === 'todo') instructionPrompt = "Analyse cet audio et extrais la liste exhaustive des tâches à accomplir avec leurs priorités. Ignore les digressions et bruits de fond.";
        if (mode === 'brut') instructionPrompt = "Transcris intégralement cet audio sans aucun commentaire ni ajout. Ignore les segments de silence pur.";

        // 🚀 Upload vers l'API Files officielle de Google Gemini (0 Mo de RAM consommée)
        uploadedGeminiFile = await ai.files.upload({
            file: req.file.path,
            config: {
                mimeType: mimeType,
                displayName: titreSource
            }
        });

        // 🧠 Modèle robuste avec fallback automatique en cas de pic de charge
        const modelesTestables = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-flash-latest'];
        let response = null;
        let dernierErreur = null;

        for (const model of modelesTestables) {
            try {
                response = await ai.models.generateContent({
                    model: model,
                    contents: [
                        { fileData: { fileUri: uploadedGeminiFile.uri, mimeType: uploadedGeminiFile.mimeType } },
                        { text: instructionPrompt }
                    ]
                });
                if (response?.text) break;
            } catch (errMod) {
                console.warn(`Modèle ${model} indisponible (${errMod.message}), bascule vers le suivant...`);
                dernierErreur = errMod;
            }
        }

        if (!response || !response.text) {
            throw dernierErreur || new Error("Échec de la génération par les modèles d'IA.");
        }

        const nouvelleSauvegarde = new Transcription({
            userId: req.user.id, 
            titre: titreSource,
            texte: response.text,
            mode: mode,
            audioUrl: audioUrl,
            audioPath: req.file.path
        });
        await nouvelleSauvegarde.save();

        res.json({ 
            success: true, 
            texte: response.text, 
            id: nouvelleSauvegarde._id,
            audioUrl: audioUrl 
        });

    } catch (error) {
        console.error("Erreur serveur :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 📜 Route Récupération de l'historique
app.get('/historique', verifierToken, async (req, res) => {
    try {
        const historique = await Transcription.find({ userId: req.user.id })
            .sort({ date: -1 })
            .limit(30);
        res.json({ success: true, historique });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🗑️ Route de suppression d'une transcription
app.delete('/historique/:id', verifierToken, async (req, res) => {
    try {
        const { id } = req.params;
        const suppression = await Transcription.findOneAndDelete({ _id: id, userId: req.user.id });

        if (!suppression) {
            return res.status(404).json({ success: false, error: "Transcription introuvable ou non autorisée." });
        }

        // 🗑️ Si l'utilisateur supprime la transcription, supprimer aussi le fichier audio associé
        if (suppression.audioPath && fs.existsSync(suppression.audioPath)) {
            fs.unlink(suppression.audioPath, (err) => {
                if (err) console.error("Erreur suppression fichier audio lié :", err);
            });
        }

        res.json({ success: true, message: "Transcription et audio supprimés avec succès." });
    } catch (error) {
        console.error("Erreur suppression :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/traduire', verifierToken, async (req, res) => {
    try {
        const body = req.body || {};
        const texteOriginal = body.texteOriginal;
        const langueCible = body.langueCible;

        if (!texteOriginal || !langueCible) return res.status(400).json({ success: false, error: "Données manquantes." });

        const promptTraduction = `Traduis le texte suivant en ${langueCible}. Conserve fidèlement la structure :\n\n${texteOriginal}`;
        
        let response = null;
        for (const model of ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-flash-latest']) {
            try {
                response = await ai.models.generateContent({
                    model: model,
                    contents: [{ text: promptTraduction }]
                });
                if (response?.text) break;
            } catch (e) {
                console.warn(`Traduction avec ${model} a échoué, essai suivant...`);
            }
        }

        if (!response?.text) throw new Error("Échec de la traduction.");

        res.json({ success: true, texteTraduit: response.text });
    } catch (error) {
        console.error("Erreur traduction :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🚀 ROUTE ENVOI PDF VIA API REST BREVO
app.post('/envoyer-pdf', verifierToken, async (req, res) => {
    try {
        const body = req.body || {};
        const emailDestinataireInput = body.emailDestinataire;
        const texteAAfficher = body.texteAAfficher;
        const titreSource = body.titreSource;
        const modePdf = body.modePdf || 'classique';

        if (!emailDestinataireInput || !texteAAfficher) {
            return res.status(400).json({ success: false, error: "Email ou texte manquant." });
        }

        const listeEmails = emailDestinataireInput
            .split(/[,;]/)
            .map(e => e.trim())
            .filter(e => e.length > 0);

        if (listeEmails.length === 0) {
            return res.status(400).json({ success: false, error: "Aucun email valide fourni." });
        }

        const destinatairesBrevo = listeEmails.map(email => ({ email }));

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers = [];
        
        doc.on('data', buffers.push.bind(buffers));
        
        doc.on('end', async () => {
            const pdfBuffer = Buffer.concat(buffers);
            const base64Pdf = pdfBuffer.toString('base64');

            try {
                const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
                    method: 'POST',
                    headers: {
                        'accept': 'application/json',
                        'api-key': process.env.BREVO_API_KEY,
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        sender: { 
                            name: "Application Gemini Audio", 
                            email: process.env.EMAIL_USER 
                        },
                        to: destinatairesBrevo,
                        subject: `📄 Compte-rendu (${modePdf}) : ${titreSource || 'Analyse Gemini'}`,
                        textContent: "Bonjour,\n\nVeuillez trouver ci-joint votre compte-rendu PDF généré par l'application.\n\nCordialement,",
                        attachment: [{ 
                            name: `compte-rendu-${modePdf}.pdf`, 
                            content: base64Pdf 
                        }]
                    })
                });

                const brevoResult = await brevoResponse.json();

                if (!brevoResponse.ok) {
                    console.error("🚨 Erreur API Brevo :", brevoResult);
                    throw new Error(brevoResult.message || "Échec de l'envoi via Brevo.");
                }

                res.json({ success: true, message: "PDF envoyé avec succès à tous les destinataires !" });

            } catch (mailError) {
                console.error("🚨 Erreur d'envoi Brevo :", mailError);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: "Erreur lors de l'envoi de l'e-mail." });
                }
            }
        });

        // Modèles de mise en page PDF
        if (modePdf === 'executif') {
            doc.rect(0, 0, doc.page.width, 90).fill('#0f172a');
            doc.fontSize(22).fillColor('#38bdf8').text('NOTE DE SYNTHÈSE', 50, 30, { align: 'left' });
            doc.fontSize(10).fillColor('#94a3b8').text(`Généré le ${new Date().toLocaleDateString()} | Source : ${titreSource}`, 50, 60);
            doc.moveDown(3);
            doc.fontSize(14).fillColor('#0f172a').text('Points Clés & Analyse', { underline: true });
            doc.moveDown(0.5);
            doc.fontSize(10).fillColor('#334155').text(texteAAfficher, { lineGap: 8, align: 'justify' });
        } else if (modePdf === 'academique') {
            doc.fontSize(20).fillColor('#1e1b4b').text('📚 Notes de Cours & Étude', { align: 'center' });
            doc.fontSize(10).fillColor('#6b7280').text(`Sujet : ${titreSource}`, { align: 'center' });
            doc.moveDown();
            doc.lineWidth(2).strokeColor('#4f46e5').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown();
            doc.fontSize(11).fillColor('#1f2937').text(texteAAfficher, { lineGap: 10, align: 'justify' });
        } else {
            doc.fontSize(20).fillColor('#4f46e5').text('Compte-Rendu Audio - Gemini', { align: 'left' });
            doc.fontSize(10).fillColor('#64748b').text(`Généré le : ${new Date().toLocaleString()}`, { align: 'left' });
            doc.moveDown();
            doc.fontSize(12).fillColor('#334155').text(`Source : ${titreSource || 'Enregistrement audio'}`, { bold: true });
            doc.moveDown();
            doc.lineWidth(1).strokeColor('#e2e8f0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown();
            doc.fontSize(11).fillColor('#1e293b').text(texteAAfficher, { lineGap: 6, align: 'justify' });
        }

        doc.fontSize(8).fillColor('#94a3b8').text('Document généré automatiquement.', 50, 750, { align: 'center', width: 500 });
        doc.end();

    } catch (error) {
        console.error("Erreur génération PDF :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});