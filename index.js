// index.js
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

const app = express();
const linkMap = new Map();

// Configuration GitHub
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'toge021';
const GITHUB_REPO = process.env.GITHUB_REPO || 'Media';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// Vérification que le token existe
if (!GITHUB_TOKEN) {
    console.error('❌ ERREUR: GITHUB_TOKEN non défini dans les variables d\'environnement');
    process.exit(1);
}

// Configuration multer pour Railway (utilise /tmp)
const upload = multer({ 
    dest: '/tmp/uploads/',
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// Créer le dossier /tmp/uploads s'il n'existe pas
if (!fs.existsSync('/tmp/uploads')) {
    fs.mkdirSync('/tmp/uploads', { recursive: true });
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.use(express.static('public'));
app.use(express.json());

function generateShortCode() {
    return crypto.randomBytes(6).toString('base64url');
}

function sanitizeFilename(filename) {
    return filename
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .replace(/__+/g, '_');
}

function generateObfuscatedPath(originalName) {
    const ext = path.extname(originalName);
    const randomName = crypto.randomBytes(16).toString('hex');
    // Changé de 'uploads/' à 'media/' pour éviter confusion
    return `media/${randomName}${ext}`;
}

async function uploadToGitHub(filePath, originalName) {
    const buffer = fs.readFileSync(filePath);
    const content = buffer.toString('base64');
    const cleanName = sanitizeFilename(originalName) || 'file.bin';
    const obfuscatedPath = generateObfuscatedPath(cleanName);
    
    try {
        // Vérifier si le fichier existe déjà
        let sha = null;
        try {
            const existingFile = await octokit.repos.getContent({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                path: obfuscatedPath,
                ref: GITHUB_BRANCH
            });
            sha = existingFile.data.sha;
        } catch (e) {
            // Fichier n'existe pas, on continue
            if (e.status !== 404) {
                console.warn('Erreur check existence:', e.message);
            }
        }

        // Upload du fichier
        await octokit.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: obfuscatedPath,
            message: `Upload: ${cleanName}`,
            content: content,
            branch: GITHUB_BRANCH,
            sha: sha
        });

        // Construire l'URL brute GitHub
        const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${obfuscatedPath}`;
        return rawUrl;
    } catch (err) {
        throw new Error(`GitHub upload error: ${err.message}`);
    }
}

// Route d'upload
app.post('/upload', upload.single('file'), async (req, res) => {
    let tempFilePath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Aucun fichier' });
        }
        tempFilePath = req.file.path;

        console.log(`📤 Upload: ${req.file.originalname} (${req.file.size} bytes)`);
        
        const githubUrl = await uploadToGitHub(tempFilePath, req.file.originalname);
        const shortCode = generateShortCode();
        const fileExt = path.extname(req.file.originalname).toLowerCase();

        let mime = 'application/octet-stream';
        if (['.jpg', '.jpeg'].includes(fileExt)) mime = 'image/jpeg';
        else if (fileExt === '.png') mime = 'image/png';
        else if (fileExt === '.gif') mime = 'image/gif';
        else if (fileExt === '.webp') mime = 'image/webp';
        else if (fileExt === '.mp4') mime = 'video/mp4';
        else if (fileExt === '.webm') mime = 'video/webm';
        else if (fileExt === '.mov') mime = 'video/quicktime';
        else if (fileExt === '.mp3') mime = 'audio/mpeg';
        else if (fileExt === '.wav') mime = 'audio/wav';
        else if (fileExt === '.ogg') mime = 'audio/ogg';
        else if (['.js', '.mjs'].includes(fileExt)) mime = 'application/javascript';
        else if (fileExt === '.css') mime = 'text/css';
        else if (fileExt === '.pdf') mime = 'application/pdf';

        linkMap.set(shortCode, {
            githubUrl: githubUrl,
            mime: mime,
            filename: req.file.originalname
        });

        // Nettoyer le fichier temporaire
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }

        console.log(`✅ Upload réussi: ${shortCode} -> ${githubUrl}`);
        
        res.json({
            success: true,
            shortUrl: `/f/${shortCode}/${encodeURIComponent(req.file.originalname)}`,
            originalName: req.file.originalname,
            githubUrl: githubUrl // Optionnel: à retirer si vous voulez cacher l'URL
        });

    } catch (err) {
        console.error('❌ Erreur upload:', err);
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch(e) {}
        }
        res.status(500).json({ error: err.message });
    }
});

// Route proxy pour masquer la source GitHub
app.get('/f/:code/:filename?', async (req, res) => {
    const code = req.params.code;
    const entry = linkMap.get(code);
    if (!entry) {
        return res.status(404).send('Lien invalide ou expiré');
    }

    try {
        const response = await fetch(entry.githubUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        res.setHeader('Content-Type', entry.mime);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(entry.filename)}"`);
        response.body.pipe(res);
    } catch (err) {
        console.error('❌ Erreur proxy:', err.message);
        res.status(502).send('Erreur lors de la récupération du fichier');
    }
});

// Route de santé pour Railway
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
    console.error('❌ Erreur serveur:', err);
    if (err instanceof multer.MulterError) {
        if (err.code === 'FILE_TOO_LARGE') {
            return res.status(413).json({ error: 'Fichier trop volumineux (max 100MB)' });
        }
        return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erreur interne du serveur' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur le port ${PORT}`);
    console.log(`📁 GitHub Repo: ${GITHUB_OWNER}/${GITHUB_REPO}`);
    console.log(`🔑 Token GitHub: ${GITHUB_TOKEN ? '✅ Configuré' : '❌ Manquant'}`);
});