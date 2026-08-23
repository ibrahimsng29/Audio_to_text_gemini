import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);
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

const transcriptionSchema = new mongoose.Schema({
    titre: { type: String, default: 'Enregistrement' },
    texte: String,
    mode: String,
    date: { type: Date, default: Date.now }
});

const Transcription = mongoose.model('Transcription', transcriptionSchema);
const upload = multer({ storage: multer.memoryStorage() });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
        if (!req.file) {
            return res.status(400).json({ success: false, error: "Aucun fichier audio reçu." });
        }

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

        if (!texteOriginal || !langueCible) {
            return res.status(400).json({ success: false, error: "Données de traduction manquantes." });
        }

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
        doc.on('end', async () => {
            const pdfData = Buffer.concat(buffers); 

            try {
                // 🚀 Envoi via l'API Resend (Contourne le blocage Render)
                const { data, error } = await resend.emails.send({
                    from: 'Acme <onboarding@resend.dev>', // Adresse de test obligatoire de Resend
                    to: emailDestinataire,
                    subject: `📄 Compte-rendu audio : ${titreSource || 'Analyse Gemini'}`,
                    text: "Bonjour,\n\nVeuillez trouver ci-joint votre compte-rendu PDF généré par l'application.\n\nCordialement,",
                    attachments: [{ 
                        filename: 'compte-rendu-gemini.pdf', 
                        content: pdfData
                    }]
                });

                if (error) {
                    console.error("🚨 Erreur API Resend :", error);
                    return res.status(500).json({ success: false, error: "Erreur API lors de l'envoi." });
                }

                res.json({ success: true, message: "PDF envoyé avec succès via API !" });

            } catch (apiError) {
                console.error("🚨 Crash API :", apiError);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: "Erreur critique de connexion à l'API." });
                }
            }
        });