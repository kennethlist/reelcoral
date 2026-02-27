# ReelCoral

A self-hosted media server for streaming video, music, books, and images through a modern web interface. Features hardware-accelerated transcoding, adaptive bitrate streaming, and a unified browser for all your media.

## Features

### Video
- Adaptive bitrate streaming via HLS with real-time transcoding
- Hardware-accelerated encoding via VAAPI or QSV, with software fallback
- Quality profiles from 240p to 4K, plus original passthrough
- Multiple audio track and subtitle support (external WebVTT or burn-in)
- Seek, resume, and playback speed controls
- Thumbnail generation (on-demand or batch) with custom thumbnail upload

### Music
- Dedicated music folder mode with album detection and cover art
- Direct playback or server-side transcoding to MP3 at configurable bitrates
- Album browsing with automatic cover art discovery (`cover.jpg`, `folder.jpg`, etc.)
- Now-playing indicator and sequential playback

### Books & Comics
- **EPUB** reader with chapter navigation, page-flip and scroll modes
- Configurable font family (bundled webfonts: Liberation, Ubuntu, Noto, Roboto, DejaVu), font size, margins, and background theme (dark, light, amber)
- **PDF** viewer with fit-to-width, fit-to-height, and fit-to-page modes
- **CBR/CBZ** comic reader with fit modes and page navigation
- Page slider and direct page number input for quick navigation
- Reading position saved per file

### Images
- Full-screen gallery with swipe and keyboard navigation
- Sequential browsing through all images in a directory

### Browsing
- Hierarchical directory navigation with breadcrumbs
- Search, alphabetical filtering, and sorting (name, newest, largest)
- Pagination with state persistence
- Thumbnail grid with format-aware covers (book covers, comic pages, PDF first pages)
- Per-file download and bulk ZIP download with multi-select
- Cross-format sibling navigation (video, audio, image, and book files in the same directory)

### General
- Simple username/password authentication with session management
- Configurable user preferences (quality, audio language, subtitle language, subtitle display)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, HLS.js |
| Backend | Python, Flask, Gunicorn (gevent) |
| Transcoding | FFmpeg with VAAPI/QSV hardware acceleration |
| Books | ebooklib (EPUB), PyMuPDF (PDF), rarfile (CBR), zipfile (CBZ) |
| Fonts | Self-hosted webfonts (Liberation, Ubuntu, Noto, Roboto, DejaVu) |
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
| `media.extensions` | File extensions to show in the browser | *(see example config)* |
| `media.music_folders` | Paths that enable music mode (e.g. `["/music"]`) | `[]` |
| `transcoding.hardware` | `vaapi`, `qsv`, or `software` | `vaapi` |
| `transcoding.max_sessions` | Max concurrent transcoding sessions | `4` |
| `music.profiles` | Audio transcoding bitrate options | *(see example config)* |
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
│   ├── public/fonts/      # Self-hosted webfonts (woff2)
│   └── src/
│       ├── pages/         # Browse, Player, AudioPlayer, Gallery, Reader, Login, etc.
│       ├── components/    # VideoCard, SearchBar, Breadcrumbs, TrackSelector, etc.
│       ├── hooks/         # Custom React hooks (useMusicPlayer, etc.)
│       └── api.ts         # API client
├── server/                # Python Flask backend
│   ├── app.py             # Flask app factory
│   ├── stream.py          # HLS streaming & transcoding
│   ├── browse.py          # Media browsing API
│   ├── ebook.py           # EPUB parsing & chapter serving
│   ├── pdf.py             # PDF page rendering
│   ├── comic.py           # CBR/CBZ page extraction
│   ├── thumbnail.py       # Thumbnail serving
│   ├── thumbnail_gen.py   # Batch thumbnail generation
│   ├── subtitle.py        # Subtitle extraction/conversion
│   └── auth.py            # Authentication
├── config.example.yml     # Configuration template
├── docker-compose.yml     # Docker Compose config
└── Dockerfile             # Multi-stage Docker build
```

## Bundled Font Licenses

All reader fonts are self-hosted with no external dependencies:

| Font | License |
|------|---------|
| Liberation Serif/Sans | SIL Open Font License 1.1 |
| Ubuntu | Ubuntu Font Licence 1.0 |
| Noto Serif/Sans | SIL Open Font License 1.1 |
| Roboto | Apache License 2.0 |
| DejaVu Serif/Sans | Bitstream Vera License |
