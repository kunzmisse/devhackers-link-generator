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

// Génère un code court de 4 caractères (chiffres et lettres)
function generateShortCode() {
    // 4 caractères aléatoires (0-9, a-z, A-Z)
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function sanitizeFilename(filename) {
    return filename
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .replace(/__+/g, '_');
}

// Nom de fichier ultra court sur GitHub (4 caractères + extension)
function generateObfuscatedPath(originalName) {
    const ext = path.extname(originalName);
    // 4 caractères hexadécimaux = 2 bytes (65536 combinaisons)
    const shortName = crypto.randomBytes(2).toString('hex');
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
        return rawUrl;
    } catch (err) {
        throw new Error(`GitHub upload error: ${err.message}`);
    }
}

// Route d'upload - retourne un lien ultra court (4 caractères)
app.post('/upload', upload.single('file'), async (req, res) => {
    let tempFilePath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Aucun fichier' });
        }
        tempFilePath = req.file.path;

        // Upload vers GitHub
        const githubUrl = await uploadToGitHub(tempFilePath, req.file.originalname);
        
        // Générer un code court de 4 caractères
        const shortCode = generateShortCode();

        // Nettoyer le fichier temporaire
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }

        // Retourner l'URL ultra courte
        res.json({
            success: true,
            shortUrl: `/${shortCode}`,
            originalName: req.file.originalname,
            githubUrl: githubUrl
        });

    } catch (err) {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch(e) {}
        }
        console.error('Upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Route pour rediriger vers l'URL GitHub
app.get('/:shortCode', async (req, res) => {
    try {
        const { shortCode } = req.params;
        
        // Vérifier que le shortCode fait 4 caractères
        if (shortCode.length !== 4) {
            return res.status(404).send('Lien non trouvé');
        }

        // Reconstruire l'URL GitHub à partir du shortCode
        
        // Solution: essayer de trouver le fichier avec le shortCode + n'importe quelle extension
        const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.mp3', '.pdf', '.txt', '.bin'];
        
        let foundUrl = null;
        let foundExt = null;
        
        for (const ext of extensions) {
            const testPath = `${shortCode}${ext}`;
            const testUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${testPath}`;
            
            try {
                const response = await fetch(testUrl, { method: 'HEAD' });
                if (response.ok) {
                    foundUrl = testUrl;
                    foundExt = ext;
                    break;
                }
            } catch (e) {
                // Continuer avec l'extension suivante
            }
        }
        
        if (!foundUrl) {
            return res.status(404).send('Fichier non trouvé');
        }
        
        // Déterminer le MIME type
        let mime = 'application/octet-stream';
        if (['.jpg','.jpeg'].includes(foundExt)) mime = 'image/jpeg';
        else if (foundExt === '.png') mime = 'image/png';
        else if (foundExt === '.gif') mime = 'image/gif';
        else if (foundExt === '.webp') mime = 'image/webp';
        else if (foundExt === '.mp4') mime = 'video/mp4';
        else if (foundExt === '.webm') mime = 'video/webm';
        else if (foundExt === '.mov') mime = 'video/quicktime';
        else if (foundExt === '.mp3') mime = 'audio/mpeg';
        else if (foundExt === '.pdf') mime = 'application/pdf';
        
        // Récupérer et envoyer le fichier
        const response = await fetch(foundUrl);
        if (!response.ok) {
            throw new Error(`GitHub HTTP ${response.status}`);
        }
        
        const filename = `${shortCode}${foundExt}`;
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        
        const arrayBuffer = await response.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
        
    } catch (err) {
        console.error('❌ Erreur:', err.message);
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