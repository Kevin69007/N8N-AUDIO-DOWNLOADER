// test.js
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/download', async (req, res) => {
    const url = req.query.url;

    if (!url) {
        return res.status(400).send('URL manquante');
    }

    try {
        // Générer un fichier temporaire
        const tmpFile = path.join(tmpdir(), `audio_${Date.now()}.m4a`);

        // Commande yt-dlp
        const cmd = `yt-dlp -f bestaudio -o "${tmpFile}" "${url}"`;

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error('Erreur yt-dlp :', stderr);
                return res.status(500).send('Erreur lors du téléchargement');
            }

            // Envoyer le fichier au client
            res.download(tmpFile, 'audio.m4a', (err) => {
                if (err) {
                    console.error('Erreur en envoyant le fichier :', err);
                }

                // Supprimer le fichier temporaire
                fs.unlink(tmpFile, (unlinkErr) => {
                    if (unlinkErr) console.error('Erreur en supprimant le fichier :', unlinkErr);
                });
            });
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Erreur interne');
    }
});

app.listen(PORT, () => {
    console.log(`Serveur lancé sur http://localhost:${PORT}`);
});
