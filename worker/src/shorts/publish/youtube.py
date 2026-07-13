"""Upload rendered clips to YouTube Shorts via the Data API v3 (videos.insert,
resumable). Reads each kept clip's publish.json (written by publish-metadata).

OAuth: a Desktop `client_secret.json` + a cached token file -- the first run
opens a browser to authorize your channel once; the stored refresh token is
reused (and auto-refreshed) after that, so later runs are non-interactive."""

import json
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

# Upload-only scope -- the least privilege that lets videos.insert work; it
# cannot read or delete anything else on the channel.
_SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
_VALID_PRIVACY = ("private", "unlisted", "public")
DEFAULT_TOKEN = Path.home() / ".peakcut" / "yt-token.json"


def _credentials(client_secret: Path, token: Path) -> Credentials:
    creds = Credentials.from_authorized_user_file(str(token), _SCOPES) if token.exists() else None
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        flow = InstalledAppFlow.from_client_secrets_file(str(client_secret), _SCOPES)
        creds = flow.run_local_server(port=0, prompt="consent")
    token.parent.mkdir(parents=True, exist_ok=True)
    token.write_text(creds.to_json())
    return creds


def _upload_one(youtube, mp4: Path, meta: dict, privacy: str) -> str:
    body = {
        "snippet": {
            "title": meta["title"],
            "description": meta.get("description", ""),
            "tags": meta.get("tags", []),
            "categoryId": str(meta.get("categoryId", "24")),
        },
        "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False},
    }
    media = MediaFileUpload(str(mp4), chunksize=-1, resumable=True, mimetype="video/mp4")
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = None
    while response is None:
        _status, response = request.next_chunk()
    return response["id"]


def publish_workdir_to_youtube(
    out_dir: Path,
    client_secret: Path,
    token: Path = DEFAULT_TOKEN,
    privacy: str | None = None,
    limit: int | None = None,
) -> list[tuple[str, str]]:
    """Upload each kept clip that has a publish.json, in clip order. Uploads are
    UNLISTED unless `privacy` overrides (or the publish.json says otherwise).
    Returns [(title, video_id)]. `limit` caps how many clips are uploaded."""
    out_dir = Path(out_dir)
    run = json.loads((out_dir / "run.json").read_text())
    creds = _credentials(Path(client_secret), Path(token))
    youtube = build("youtube", "v3", credentials=creds)

    results: list[tuple[str, str]] = []
    for clip in run["clips"]:
        if limit is not None and len(results) >= limit:
            break
        if clip.get("dropped_reason"):
            continue
        mp4 = (clip.get("paths") or {}).get("mp4")
        if not mp4 or not Path(mp4).exists():
            continue
        pub = Path(mp4).parent / "publish.json"
        if not pub.exists():
            continue
        meta = json.loads(pub.read_text())
        chosen = privacy or meta.get("privacyStatus") or "unlisted"
        if chosen not in _VALID_PRIVACY:
            chosen = "unlisted"
        video_id = _upload_one(youtube, Path(mp4), meta, chosen)
        results.append((meta.get("title", "clip"), video_id))
    return results
