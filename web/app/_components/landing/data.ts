// Shared copy/data for the landing page sections. Plain data, no client
// directive needed — imported by both server (page.tsx) and client section
// components.

export const EVIDENCE_ROWS = [
  { marker: "energy spike", value: "+2.1σ", time: "00:14" },
  { marker: "laughter", value: "", time: "00:45" },
  { marker: "quote", value: '"...you won\'t believe"', time: "" },
] as const;

export const VERDICT_ROW = { marker: "verdict", value: "KEEP · hook ✓", time: "", isVerdict: true } as const;

export const STEPS = [
  {
    index: "01",
    title: "Ingest",
    body: "Paste a YouTube URL or upload the raw file. We pull audio, video, and a transcript.",
  },
  {
    index: "02",
    title: "Measure signals",
    body: "Audio energy, laughter, speech-rate, scene cuts, and faces — scored second by second.",
  },
  {
    index: "03",
    title: "Agent crew debates",
    body: "Scout finds candidate moments, Critic scores them against the signals, Surgeon trims the cut.",
  },
  {
    index: "04",
    title: "Render + QA",
    body: "Hook Writer titles the clip, a final pass checks the cut, and it ships with its receipts.",
  },
];

export const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: "/mo",
    features: [
      "60 minutes of video / month",
      "3 caption styles",
      "Watermark on exports",
      "Your first clips today",
    ],
    cta: "Start free",
  },
  {
    name: "Creator",
    price: "$19",
    period: "/mo",
    features: [
      "300 minutes / month",
      "No watermark",
      "All styles + face-aware crop",
      "Caption restyle",
      "Priority queue",
    ],
    cta: "Start free",
    highlighted: true,
  },
  {
    name: "Pro",
    price: "$49",
    period: "/mo",
    features: [
      "1,200 minutes / month",
      "Everything in Creator",
      "API access",
      "Bulk upload",
      "Team seats",
    ],
    cta: "Start free",
  },
];

export const TRUST_STATS = [
  { value: 2, prefix: "", suffix: " min", decimals: 0, label: "avg. processing per video" },
  { value: 0.12, prefix: "$", suffix: "", decimals: 2, label: "avg. compute cost per video" },
  { value: 24, prefix: "", suffix: "/sec", decimals: 0, label: "signals measured" },
  { value: 4, prefix: "", suffix: "", decimals: 0, label: "agents debate every clip" },
] as const;

export const FEATURES = [
  {
    icon: "Crop",
    title: "Face-aware crop",
    body: "Tracks the speaker's face and reframes to 9:16 automatically — no dead space, no cropped foreheads.",
  },
  {
    icon: "Captions",
    title: "Karaoke captions",
    body: "Word-by-word captions in 3 styles, synced to speech down to the syllable.",
  },
  {
    icon: "Wand2",
    title: "One-click restyle",
    body: "Swap caption styles and re-render without re-analyzing the source video.",
  },
  {
    icon: "Link2",
    title: "YouTube link or upload",
    body: "Paste a URL or drop the raw file — ingest handles either the same way.",
  },
  {
    icon: "Zap",
    title: "Cloud-fast rendering",
    body: "Full analysis, agent debate, and render in about 2 minutes end to end.",
  },
] as const;

export const DEMO_CLIP = {
  score: 92,
  caption: "\"...the moment everything changed\"",
  rows: [
    { marker: "speech-rate spike", value: "+1.8σ", time: "00:22" },
    { marker: "scene cut", value: "", time: "00:31" },
    { marker: "quote", value: '"the moment everything changed"', time: "" },
  ],
  verdict: { marker: "verdict", value: "KEEP · hook ✓", time: "", isVerdict: true },
} as const;

export const FAQS = [
  {
    q: "Is my video private?",
    a: "Yes. Your source video and clips are processed for you only, never used to train models, and you can delete them at any time.",
  },
  {
    q: "How accurate is the AI at picking clips?",
    a: "It doesn't guess — every candidate is scored against measured signals (audio energy, laughter, speech-rate, scene cuts, faces), then debated by the agent crew. You see the exact evidence behind every score, so you can trust the pick or overrule it.",
  },
  {
    q: "What does it cost?",
    a: "Compute runs about $0.12 per video. Plans are priced by minutes processed per month, not seats — see pricing below.",
  },
  {
    q: "What kind of videos work best?",
    a: "Talking-head content, podcasts, streams, and interviews — anything with clear speech and a few standout moments. Longer source videos give the agent crew more to work with.",
  },
  {
    q: "Can I tweak or restyle the clips?",
    a: "Yes — swap caption styles, adjust the crop, or re-cut the timing without re-running the full analysis.",
  },
] as const;
