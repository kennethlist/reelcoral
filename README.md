# ReelCoral

A self-hosted media streaming application for browsing, playing, and managing video and image files from a local media library. Features hardware-accelerated transcoding, adaptive bitrate streaming via HLS, and a modern web interface.

## Features

- **Media Browsing** - Hierarchical directory browsing with search, letter filtering, sorting, and pagination
- **Video Streaming** - Adaptive bitrate streaming via HLS with hardware-accelerated transcoding (VAAPI, QSV, or software fallback)
- **Multiple Quality Profiles** - 4K, 1440p, 1080p, 720p, 480p, 360p, 240p, and original passthrough
- **Subtitle Support** - Multiple subtitle tracks with burn-in or external (client-side) rendering, WebVTT conversion
- **Image Gallery** - Full-screen image viewing with touch and keyboard navigation
- **Thumbnail Management** - On-demand and batch thumbnail generation with custom thumbnail selection
- **Custom Video Player** - Timeline seeking, playback speed control, audio/subtitle track selection, volume controls
- **Authentication** - Simple username/password authentication with session management
- **User Preferences** - Configurable quality, audio language, subtitle language, and subtitle display settings

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, HLS.js |
| Backend | Python, Flask, Gunicorn (gevent) |
| Transcoding | FFmpeg with VAAPI/QSV hardware acceleration |
| Deployment | Docker, Docker Compose |

## Quick Start

### Docker Compose (Recommended)

1. Copy and edit the configuration file:
   ```bash
   cp config.example.yml config.yml
   ```

2. Edit `config.yml` - at minimum, change the `secret` and `auth` credentials.

3. Place your media files in the `media/` directory (or update the volume mount in `docker-compose.yml`).

4. Start the application:
   ```bash
   docker-compose up -d
   ```

5. Access at `http://localhost:8080`

### Manual Setup

**Prerequisites:** Python 3, Node.js 22+, FFmpeg

```bash
# Build the frontend
cd frontend
npm install
npm run build
cd ..

# Install backend dependencies
cd server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Run
gunicorn --bind 0.0.0.0:8080 --worker-class gevent --workers 1 \
  --worker-connections 200 --timeout 300 "app:create_app()"
```

For frontend development with hot reload:
```bash
cd frontend
npm run dev  # http://localhost:5173
```

## Configuration

Configuration is managed through `config.yml`. See `config.example.yml` for the full template.

### Key Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `server.port` | Server port | `8080` |
| `server.secret` | Session secret key | *(change this)* |
| `media.root` | Media library path | `/media` |
| `transcoding.hardware` | `vaapi`, `qsv`, or `software` | `vaapi` |
| `transcoding.max_sessions` | Max concurrent transcoding sessions | `4` |
| `thumbnails.generate_on_fly` | Generate thumbnails on first access | `true` |
| `thumbnails.threads` | Threads for batch thumbnail generation | `24` |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MEDIA_CONFIG` | Path to config.yml | `/config/config.yml` |
| `MEDIA_CACHE_DIR` | Thumbnail cache directory | `/cache/thumbnails` |
| `MEDIA_STREAM_TMPDIR` | Temp directory for HLS segments | `/tmp/media_streams` |

### Hardware Acceleration

For VAAPI (Intel GPU), ensure `/dev/dri` is passed through to the container (included by default in `docker-compose.yml`). Set `transcoding.hardware` to `vaapi` or `qsv` as appropriate. Use `software` as a fallback if no compatible GPU is available.

## Project Structure

```
reelcoral/
├── frontend/              # React/TypeScript frontend
│   └── src/
│       ├── pages/         # Browse, Player, Gallery, Login, Preferences, ThumbnailGen
│       ├── components/    # VideoCard, SearchBar, Breadcrumbs, TrackSelector, etc.
│       ├── hooks/         # Custom React hooks
│       └── api.ts         # API client
├── server/                # Python Flask backend
│   ├── app.py             # Flask app factory
│   ├── stream.py          # HLS streaming & transcoding
│   ├── browse.py          # Media browsing API
│   ├── thumbnail.py       # Thumbnail serving
│   ├── thumbnail_gen.py   # Batch thumbnail generation
│   ├── subtitle.py        # Subtitle extraction/conversion
│   └── auth.py            # Authentication
├── config.example.yml     # Configuration template
├── docker-compose.yml     # Docker Compose config
└── Dockerfile             # Multi-stage Docker build
```
