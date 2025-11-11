import { spawn } from "child_process";

const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"; // remplace par ta vidéo

const ytdlp = spawn("yt-dlp", [
  "-f",
  "bestaudio",
  "-o",
  "-",
  url
]);

ytdlp.stdout.on("data", (chunk) => {
  console.log("Reçu un chunk de données :", chunk.length);
});

ytdlp.stderr.on("data", (data) => {
  console.error("Erreur yt-dlp :", data.toString());
});

ytdlp.on("close", (code) => {
  console.log("yt-dlp terminé avec le code :", code);
});
