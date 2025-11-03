# Vimeo Audio Downloader

A simple Express.js API that downloads audio from Vimeo videos using yt-dlp.

## Features

- Download audio from Vimeo URLs
- Converts to MP3 format
- RESTful API endpoint
- Health check endpoint

## API Endpoints

### POST /download-audio
Downloads audio from a Vimeo URL.

**Request Body:**
```json
{
  "vimeoUrl": "https://vimeo.com/...",
  "videoId": "unique-identifier"
}
```

**Response:**
Returns the MP3 file as a download.

### GET /health
Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

The server will run on port 3000 (or the PORT environment variable if set).

## Railway Deployment

This project is ready to deploy on Railway:

1. Push your code to a Git repository (GitHub, GitLab, etc.)
2. Create a new project on Railway
3. Connect your repository
4. Railway will automatically detect the Dockerfile and deploy

The Dockerfile includes all necessary dependencies:
- Node.js 18
- Python 3 (for yt-dlp)
- yt-dlp
- ffmpeg

## Environment Variables

- `PORT` - The port the server will listen on (default: 3000)

## Requirements

- Node.js 18+
- yt-dlp
- ffmpeg
