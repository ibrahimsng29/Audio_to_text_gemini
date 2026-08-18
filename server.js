import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🔗 Connexion à MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connecté avec succès à MongoDB Atlas !'))
    .catch(err => console.error('❌ Erreur de connexion MongoDB :', err));

// 📐 Schéma et Modèle pour enregistrer l'historique
const transcriptionSchema = new mongoose.Schema({
    titre: { type: String, default: 'Enregistrement' },
    texte: String,
    mode: String,
    date: { type: Date, default: Date.now }
});

const Transcription = mongoose.model('Transcription', transcriptionSchema);

const upload = multer({ storage: multer.memoryStorage() });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Route de transcription + Sauvegarde dans MongoDB
app.post('/transcrire', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: "Aucun fichier audio reçu." });
        }

        const mode = req.body.mode || 'resume';
        const titreSource = req.body.titreSource || 'Enregistrement audio';
        const audioBase64 = req.file.buffer.toString("base64");
        let mimeType = req.file.mimetype;
        if (!mimeType || mimeType === 'application/octet-stream') {
            mimeType = 'audio/mp3';
        }

        let instructionPrompt = "Transcris cet audio en français de manière propre (en enlevant les hésitations), puis donne un court résumé des points clés.";
        if (mode === 'bullet') {
            instructionPrompt = "Transcris cet audio, puis fais-en un résumé détaillé structuré sous forme de puces (bullet points) claires.";
        } else if (mode === 'todo') {
            instructionPrompt = "Analyse cet audio, transcris-le brièvement, et extrais une liste claire des tâches à accomplir sous forme de To-Do List.";
        } else if (mode === 'brut') {
            instructionPrompt = "Transcris fidèlement et intégralement cet audio en français, sans commentaire.";
        }

        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [
                { inlineData: { mimeType: mimeType, data: audioBase64 } },
                { text: instructionPrompt }
            ]
        });

        // 💾 Enregistrement automatique dans la base de données
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

// 2. Nouvelle Route : Récupérer l'historique enregistré en BDD
app.get('/historique', async (req, res) => {
    try {
        const historique = await Transcription.find().sort({ date: -1 }).limit(20);
        res.json({ success: true, historique });
    } catch (error) {
        console.error("Erreur historique :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Route : Génération de PDF et Envoi par Gmail
app.post('/envoyer-pdf', async (req, res) => {
    try {
        const { emailDestinataire, texteAAfficher, titreSource } = req.body;

        if (!emailDestinataire || !texteAAfficher) {
            return res.status(400).json({ success: false, error: "Email ou texte manquant." });
        }

        const pdfPath = path.join('uploads', `compte-rendu-${Date.now()}.pdf`);
        if (!fs.existsSync('uploads')) {
            fs.mkdirSync('uploads');
        }

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);

        doc.fontSize(20).fillColor('#4f46e5').text('Compte-Rendu Audio - Gemini', { align: 'left' });
        doc.fontSize(10).fillColor('#64748b').text(`Généré le : ${new Date().toLocaleString()}`, { align: 'left' });
        doc.moveDown();
        
        doc.fontSize(12).fillColor('#334155').text(`Source : ${titreSource || 'Enregistrement audio'}`, { bold: true });
        doc.moveDown();
        doc.lineWidth(1).strokeColor('#e2e8f0').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown();

        doc.fontSize(11).fillColor('#1e293b').text(texteAAfficher, { lineGap: 6, align: 'justify' });
        doc.fontSize(8).fillColor('#94a3b8').text('Document généré automatiquement par ton application Audio-to-Text Gemini.', 50, 750, { align: 'center', width: 500 });

        doc.end();

        stream.on('finish', async () => {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                }
            });

            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: emailDestinataire,
                subject: `📄 Compte-rendu audio : ${titreSource || 'Analyse Gemini'}`,
                text: "Bonjour,\n\nVous trouverez ci-joint le compte-rendu professionnel de votre fichier audio.\n\nCordialement,\nVotre Application",
                attachments: [{ filename: 'compte-rendu-gemini.pdf', path: pdfPath }]
            };

            await transporter.sendMail(mailOptions);
            fs.unlinkSync(pdfPath);

            res.json({ success: true, message: "PDF envoyé par e-mail avec succès !" });
        });

    } catch (error) {
        console.error("Erreur envoi PDF :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Route : Traduction
app.post('/traduire', async (req, res) => {
    try {
        const { texteOriginal, langueCible } = req.body;
        if (!texteOriginal || !langueCible) {
            return res.status(400).json({ success: false, error: "Texte ou langue cible manquant." });
        }

        const promptTraduction = `Traduis le texte suivant en ${langueCible}. Conserve fidèlement la structure :\n\n${texteOriginal}`;
        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [{ text: promptTraduction }]
        });

        res.json({ success: true, texteTraduit: response.text });
    } catch (error) {
        console.error("Erreur de traduction :", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🚀 Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});