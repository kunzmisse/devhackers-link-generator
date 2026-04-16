// index.js
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

const app = express();
const upload = multer({ dest: 'uploads/' });
const linkMap = new Map();

// Configuration GitHub
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = 'toge021';
const GITHUB_REPO = 'Media';
const GITHUB_BRANCH = 'main';

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
    return `uploads/${randomName}${ext}`;
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
        }

        // Upload du fichier
        const response = await octokit.repos.createOrUpdateFileContents({
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
    try {
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });

        const githubUrl = await uploadToGitHub(req.file.path, req.file.originalname);
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

        fs.unlink(req.file.path, () => {});

        res.json({
            success: true,
            shortUrl: `/f/${shortCode}/${encodeURIComponent(req.file.originalname)}`,
            originalName: req.file.originalname
        });

    } catch (err) {
        console.error('Erreur upload:', err);
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: err.message });
    }
});

// Route proxy pour masquer la source GitHub
app.get('/f/:code/:filename?', async (req, res) => {
    const code = req.params.code;
    const entry = linkMap.get(code);
    if (!entry) return res.status(404).send('Lien invalide ou expiré');

    try {
        const response = await fetch(entry.githubUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        res.setHeader('Content-Type', entry.mime);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(entry.filename)}"`);
        response.body.pipe(res);
    } catch (err) {
        console.error('Erreur proxy:', err.message);
        res.status(502).send('Erreur lors de la récupération du fichier');
    }
});

app.listen(3000, () => {
    console.log('Serveur démarré sur http://localhost:3000');
});