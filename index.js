// index.js
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

const app = express();

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

// Génère un code ultra court de 4 caractères
function generateShortCode() {
    return crypto.randomBytes(2).toString('hex'); // 4 caractères hexadécimaux
}

function sanitizeFilename(filename) {
    return filename
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .replace(/__+/g, '_');
}

// Nom de fichier ultra court sur GitHub: juste 4 caractères hex + extension
function generateObfuscatedPath(originalName) {
    const ext = path.extname(originalName);
    const shortName = crypto.randomBytes(2).toString('hex'); // 4 caractères
    return `${shortName}${ext}`;
}

async function uploadToGitHub(filePath, originalName) {
    const buffer = fs.readFileSync(filePath);
    const content = buffer.toString('base64');
    const obfuscatedPath = generateObfuscatedPath(originalName);
    
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
            message: `Upload: ${obfuscatedPath}`,
            content: content,
            branch: GITHUB_BRANCH,
            sha: sha
        });

        // Construire l'URL brute GitHub
        const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${obfuscatedPath}`;
        return { rawUrl, obfuscatedPath };
    } catch (err) {
        throw new Error(`GitHub upload error: ${err.message}`);
    }
}

// Route d'upload
app.post('/upload', upload.single('file'), async (req, res) => {
    let tempFilePath = null;
    try {
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
        tempFilePath = req.file.path;

        const { rawUrl, obfuscatedPath } = await uploadToGitHub(tempFilePath, req.file.originalname);

        if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

        // URL ultra courte
        res.json({
            success: true,
            shortUrl: `/${obfuscatedPath}`,
            originalName: req.file.originalname,
            githubUrl: rawUrl
        });

    } catch (err) {
        if (tempFilePath && fs.existsSync(tempFilePath)) try { fs.unlinkSync(tempFilePath); } catch(e) {}
        res.status(500).json({ error: err.message });
    }
});

// Route ultra courte: /a3f2.mp4 (4 caractères + extension)
app.get('/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        
        // Vérifier que le nom du fichier est au format: 4 caractères hex + extension
        const match = filename.match(/^([0-9a-f]{4})\.([a-zA-Z0-9]+)$/i);
        if (!match) {
            return res.status(404).send('Lien invalide');
        }
        
        const githubUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${filename}`;
        
        const fileExt = path.extname(filename).toLowerCase();

        let mime = 'application/octet-stream';
        if (['.jpg','.jpeg'].includes(fileExt)) mime = 'image/jpeg';
        else if (fileExt === '.png') mime = 'image/png';
        else if (fileExt === '.gif') mime = 'image/gif';
        else if (fileExt === '.webp') mime = 'image/webp';
        else if (fileExt === '.mp4') mime = 'video/mp4';
        else if (fileExt === '.webm') mime = 'video/webm';
        else if (fileExt === '.mov') mime = 'video/quicktime';
        else if (fileExt === '.mp3') mime = 'audio/mpeg';
        else if (fileExt === '.pdf') mime = 'application/pdf';

        const response = await fetch(githubUrl);
        if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);

        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

        const arrayBuffer = await response.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));

    } catch (err) {
        console.error('❌ Erreur proxy:', err.message);
        res.status(502).send('Erreur: ' + err.message);
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