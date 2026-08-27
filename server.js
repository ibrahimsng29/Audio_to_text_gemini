import { Resend } from 'resend';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs'; // 🛡️ Ajout pour le hachage des mots de passe
import jwt from 'jsonwebtoken'; // 🎫 Ajout pour la création des sessions (Tokens)

const resend = new Resend(process.env.RESEND_API_KEY);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// 🛠️ Middlewares de parsing pour sécuriser req.body
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Connexion MongoDB
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('✅ Connecté à MongoDB Atlas !'))
        .catch(err => console.error('❌ Erreur MongoDB :', err));
}

// 🛡️ NOUVEAU : Modèle Utilisateur
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    dateCreation: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 🔄 MODIFIÉ : Modèle Transcription
const transcriptionSchema = new mongoose.Schema({
    // userId est optionnel pour l'instant, le temps que tu mettes à jour ton interface front-end
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, 
    titre: { type: String, default: 'Enregistrement' },
    texte: String,
    mode: String,
    date: { type: Date, default: Date.now }
});
const Transcription = mongoose.model('Transcription', transcriptionSchema);

const upload = multer({ storage: multer.memoryStorage() });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ==========================================
// 🔐 ROUTES D'AUTHENTIFICATION (NOUVEAU)
// ==========================================

// Inscription
app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis." });

        // Vérifier si l'utilisateur existe déjà
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ error: "Cet email est déjà utilisé." });

        // Hacher le mot de passe
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Sauvegarder le nouvel utilisateur
        const newUser = new User({ email, password: hashedPassword });
        await newUser.save();

        res.status(201).json({ success: true, message: "Compte créé avec succès !" });
    } catch (error) {
        console.error("Erreur inscription :", error);
        res.status(500).json({ success: false, error: "Erreur lors de la création du compte." });
    }
});

// Connexion
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Trouver l'utilisateur
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "Email ou mot de passe incorrect." });

        // Vérifier le mot de passe
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Email ou mot de passe incorrect." });

        // Créer le token JWT (Passeport)
        const tokenSecret = process.env.JWT_SECRET || 'cle_secrete_provisoire_pour_le_dev';
        const token = jwt.sign({ id: user._id, email: user.email }, tokenSecret, { expiresIn: '24h' });

        res.json({ success: true, token, email: user.email, message: "Connexion réussie !" });
    } catch (error) {
        console.error("Erreur connexion :", error);
        res.status(500).json({ success: false, error: "Erreur lors de la connexion." });
    }
});

// ==========================================
// 🎙️ ROUTES DE L'APPLICATION (EXISTANTES)
// ==========================================

// Page d'accueil
app.get('/', (req, res) => {
    const publicIndexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(publicIndexPath)) {
        res.sendFile(publicIndexPath);
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// 1. Transcription
app.post('/transcrire', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "Aucun fichier audio reçu." });

        const mode = req.body?.mode || 'resume';
        const titreSource = req.body?.titreSource || 'Enregistrement audio';
        const audioBase64 = req.file.buffer.toString("base64");
        let mimeType = req.file.mimetype || 'audio/mp3';

        let instructionPrompt = "Transcris cet audio en français de manière propre, puis donne un résumé.";
        if (mode === 'bullet') instructionPrompt = "Transcris cet audio et fais un résumé sous forme de puces.";
        if (mode === 'todo') instructionPrompt = "Analyse cet audio et extrais la liste des tâches à accomplir.";
        if (mode === 'brut') instructionPrompt = "Transcris intégralement cet audio sans commentaire.";

        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [
                { inlineData: { mimeType: mimeType, data: audioBase64 } },
                { text: instructionPrompt }
            ]
        });

        const nouvelleSauvegarde = new Transcription({
            titre: titreSource,
            texte: response.text,
            mode: mode
        });
        await nouvelleSauvegarde.save();

        res.json({ success: true, texte: response.text, id: nouvelleSauvegarde._id });
    } catch (error) {
        console.error("Erreur serveur :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Historique
app.get('/historique', async (req, res) => {
    try {
        const historique = await Transcription.find().sort({ date: -1 }).limit(20);
        res.json({ success: true, historique });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Traduction
app.post('/traduire', async (req, res) => {
    try {
        const body = req.body || {};
        const texteOriginal = body.texteOriginal;
        const langueCible = body.langueCible;

        if (!texteOriginal || !langueCible) return res.status(400).json({ success: false, error: "Données manquantes." });

        const promptTraduction = `Traduis le texte suivant en ${langueCible}. Conserve fidèlement la structure :\n\n${texteOriginal}`;
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [{ text: promptTraduction }]
        });

        res.json({ success: true, texteTraduit: response.text });
    } catch (error) {
        console.error("Erreur traduction :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Envoi PDF
app.post('/envoyer-pdf', async (req, res) => {
    try {
        const body = req.body || {};
        const emailDestinataire = body.emailDestinataire;
        const texteAAfficher = body.texteAAfficher;
        const titreSource = body.titreSource;

        if (!emailDestinataire || !texteAAfficher) return res.status(400).json({ success: false, error: "Email ou texte manquant." });

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers = [];
        
        doc.on('data', buffers.push.bind(buffers));
        
        doc.on('end', async () => {
            const pdfData = Buffer.concat(buffers);
            const base64Pdf = pdfData.toString('base64'); 

            try {
                const resendResponse = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        from: 'Application Gemini <onboarding@resend.dev>', 
                        to: [emailDestinataire], 
                        subject: `📄 Compte-rendu audio : ${titreSource || 'Analyse Gemini'}`,
                        text: "Bonjour,\n\nVeuillez trouver ci-joint votre compte-rendu PDF généré par l'application.\n\nCordialement,",
                        attachments: [{ 
                            filename: 'compte-rendu-gemini.pdf', 
                            content: base64Pdf 
                        }]
                    })
                });

                if (!resendResponse.ok) {
                    const errorData = await resendResponse.json();
                    throw new Error(`L'API Resend a rejeté l'envoi: ${errorData.message}`);
                }

                res.json({ success: true, message: "PDF envoyé avec succès via Resend !" });

            } catch (apiError) {
                console.error("🚨 Erreur d'envoi Resend :", apiError);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: "Erreur d'envoi via l'API Resend." });
                }
            }
        });

        doc.fontSize(20).fillColor('#4f46e5').text('Compte-Rendu Audio - Gemini', { align: 'left' });
        doc.fontSize(10).fillColor('#64748b').text(`Généré le : ${new Date().toLocaleString()}`, { align: 'left' });
        doc.moveDown();
        doc.fontSize(12).fillColor('#334155').text(`Source : ${titreSource || 'Enregistrement audio'}`, { bold: true });
        doc.moveDown();
        doc.lineWidth(1).strokeColor('#e2e8f0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown();
        doc.fontSize(11).fillColor('#1e293b').text(texteAAfficher, { lineGap: 6, align: 'justify' });
        doc.fontSize(8).fillColor('#94a3b8').text('Document généré automatiquement.', 50, 750, { align: 'center', width: 500 });
        doc.end();

    } catch (error) {
        console.error("Erreur génération PDF :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🚀 Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});