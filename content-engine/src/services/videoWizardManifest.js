/**
 * Video setup wizard manifest.
 *
 * Purpose:      Describe the per-funnel video setup as an ordered list of steps,
 *               one screen each, for the step-by-step wizard that replaces the
 *               old flat funnel config form. Each step names the funnel_config
 *               fields it edits (same descriptor shape the config UI already
 *               renders) plus the keys that must be filled for the step to count
 *               as complete (drives the "done" ticks in the step rail).
 * Responsibility: Pure data + tiny helpers; no I/O, no rendering.
 * Dependencies: none.
 *
 * Field descriptor shape (matches configManifest / FUNNEL_FIELDS so the existing
 * fieldRow renderer handles it): { key, label, type?, options?, default?,
 * placeholder?, help? }. Supported types: text (default) | time | weekdays |
 * select | secret | json | textarea. The publish step's postforme_* fields are
 * rendered by the account-picker widgets, keyed by name.
 *
 * Values persist to funnel_config as flat keys; downstream pipeline steps read
 * them. Building the wizard shell (this step) does not wire the providers — a
 * saved field is just stored config until its stage is built.
 */

export const WIZARD_STEPS = [
  {
    id: 'basics',
    title: 'Funnel basics',
    icon: 'ti-adjustments',
    desc: 'Where the content comes from, who approves it, and when it runs.',
    required: ['sheet_id', 'drive_folder_id', 'approval_email', 'cta_link'],
    fields: [
      { key: 'sheet_id', label: 'Content sheet ID' },
      { key: 'sheet_tab', label: 'Sheet tab name (blank = first tab)', placeholder: 'e.g. Sheet1 / Content' },
      { key: 'drive_folder_id', label: 'Drive folder ID (media for this funnel)' },
      { key: 'approval_email', label: 'Approval email' },
      { key: 'cta_link', label: 'CTA / assessment link' },
      { key: 'audience_prefix', label: 'Audience prefix (caption line, optional)' },
      { key: 'generate_time', label: 'Generate/approval time (IST)', type: 'time', default: '22:00' },
      { key: 'generate_days', label: 'Days to run (blank = every day)', type: 'weekdays' },
      { key: 'publish_time', label: 'Publish time (IST)', type: 'time', default: '08:02' },
    ],
  },
  {
    id: 'research',
    title: 'Topic & research',
    icon: 'ti-bulb',
    desc: 'Let the cloud research a topic and draft the day’s angle, or script it yourself.',
    required: [],
    fields: [
      {
        key: 'research_mode', label: 'Source of the daily idea', type: 'select', default: 'manual',
        options: [
          { value: 'manual', label: 'Manual — I fill the sheet' },
          { value: 'auto', label: 'Auto-research — the cloud picks the topic' },
        ],
      },
      { key: 'research_topics', label: 'Topic seeds (one per line)', type: 'textarea', placeholder: 'e.g. Gita leadership for founders\ncorporate dharma training' },
      { key: 'research_count', label: 'How many days to plan ahead', placeholder: 'e.g. 7' },
    ],
  },
  {
    id: 'script',
    title: 'Script',
    icon: 'ti-writing',
    desc: 'How the script is produced and the voice it should carry.',
    required: [],
    fields: [
      {
        key: 'script_source', label: 'Script source', type: 'select', default: 'sheet',
        options: [
          { value: 'sheet', label: 'From the content sheet' },
          { value: 'ai', label: 'AI-written from the topic' },
        ],
      },
      { key: 'script_tone', label: 'Tone & rules', type: 'textarea', placeholder: 'length (~220 words), voice, do / don’t, CTA style' },
    ],
  },
  {
    id: 'images',
    title: 'Images (selectable)',
    icon: 'ti-photo',
    desc: 'Generate stills from the script. Review and keep the good ones before they are animated.',
    required: [],
    fields: [
      {
        key: 'image_size', label: 'Image size', type: 'select', default: 'portrait',
        options: [
          { value: 'portrait', label: 'Portrait (2:3) — reels' },
          { value: 'square', label: 'Square (1:1)' },
        ],
      },
      { key: 'image_count', label: 'Images per video', placeholder: 'e.g. 12' },
      { key: 'image_style', label: 'Image style prompt', type: 'textarea', placeholder: 'look, palette, composition, consistency notes' },
      {
        key: 'image_review', label: 'Before animating', type: 'select', default: 'approve',
        options: [
          { value: 'approve', label: 'Let me keep / regenerate each' },
          { value: 'auto', label: 'Use all automatically' },
        ],
      },
    ],
  },
  {
    id: 'animate',
    title: 'Image → video',
    icon: 'ti-movie',
    desc: 'Animate each kept still into a short clip. Clips are saved to Drive, then stitched later.',
    required: ['animation_api_key'],
    fields: [
      {
        key: 'animation_provider', label: 'Animation provider', type: 'select', default: 'kling',
        options: [
          { value: 'kling', label: 'Kling — standard (cheapest)' },
          { value: 'runway', label: 'Runway Gen-4' },
          { value: 'hailuo', label: 'Hailuo / MiniMax' },
        ],
      },
      { key: 'animation_api_key', label: 'Provider API key', type: 'secret' },
      {
        key: 'clip_length', label: 'Clip length', type: 'select', default: '5',
        options: [
          { value: '5', label: '5 seconds' },
          { value: '8', label: '8 seconds' },
          { value: '10', label: '10 seconds' },
        ],
      },
      {
        key: 'motion', label: 'Motion', type: 'select', default: 'subtle',
        options: [
          { value: 'subtle', label: 'Subtle drift' },
          { value: 'cinematic', label: 'Cinematic' },
          { value: 'energetic', label: 'Energetic' },
        ],
      },
    ],
  },
  {
    id: 'voiceover',
    title: 'Voiceover',
    icon: 'ti-microphone',
    desc: 'Clone a voice from your script, or drop your own recording in Drive and we pick it up.',
    required: [],
    fields: [
      {
        key: 'voiceover_mode', label: 'Voiceover source', type: 'select', default: 'clone',
        options: [
          { value: 'clone', label: 'Clone from the script (automated)' },
          { value: 'upload', label: 'I upload my own recording' },
        ],
      },
      { key: 'voiceover_folder_id', label: 'Drive folder for my uploads (upload mode)' },
      {
        key: 'tts_provider', label: 'Clone provider (clone mode)', type: 'select', default: 'elevenlabs',
        options: [
          { value: 'elevenlabs', label: 'ElevenLabs' },
          { value: 'heygen', label: 'HeyGen' },
        ],
      },
      { key: 'tts_api_key', label: 'Clone provider API key', type: 'secret' },
      { key: 'voice_id', label: 'Voice ID', placeholder: 'the cloned voice to use' },
    ],
  },
  {
    id: 'transcript',
    title: 'Transcript',
    icon: 'ti-file-text',
    desc: 'Get word-level timestamps so captions and cuts line up with the voiceover.',
    required: [],
    fields: [
      {
        key: 'transcript_source', label: 'Timestamps from', type: 'select', default: 'from_voiceover',
        options: [
          { value: 'from_voiceover', label: 'The clone provider (already timed)' },
          { value: 'whisper', label: 'Whisper API' },
          { value: 'turboscribe', label: 'TurboScribe' },
        ],
      },
      { key: 'transcript_api_key', label: 'Transcription API key (Whisper / TurboScribe)', type: 'secret' },
      {
        key: 'captions', label: 'On-screen captions', type: 'select', default: 'on',
        options: [
          { value: 'on', label: 'Burn captions into the video' },
          { value: 'off', label: 'No captions' },
        ],
      },
    ],
  },
  {
    id: 'stitch',
    title: 'Stitch (FFmpeg)',
    icon: 'ti-scissors',
    desc: 'Combine the clips, voiceover, and captions into one finished reel.',
    required: [],
    fields: [
      {
        key: 'aspect', label: 'Aspect ratio', type: 'select', default: '9:16',
        options: [
          { value: '9:16', label: '9:16 (reels / shorts)' },
          { value: '1:1', label: '1:1 (square)' },
          { value: '16:9', label: '16:9 (landscape)' },
        ],
      },
      { key: 'max_duration', label: 'Max duration (seconds)', placeholder: 'e.g. 90' },
      {
        key: 'burn_captions', label: 'Caption burn-in', type: 'select', default: 'on',
        options: [
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
      },
      { key: 'music_folder_id', label: 'Background music Drive folder (optional)' },
    ],
  },
  {
    id: 'review',
    title: 'Review & approve',
    icon: 'ti-mail',
    desc: 'The finished reel is emailed to you and plays inline. Approve, or reply with changes and it reworks until you approve.',
    required: [],
    fields: [
      {
        key: 'inline_play', label: 'Email preview', type: 'select', default: 'on',
        options: [
          { value: 'on', label: 'Play the video inside the email' },
          { value: 'off', label: 'Link to the video only' },
        ],
      },
      { key: 'review_hint', label: 'Reply-box hint (optional)', placeholder: 'e.g. say what to change and it will rework' },
    ],
  },
  {
    id: 'publish',
    title: 'Publish',
    icon: 'ti-send',
    desc: 'Once approved, the reel is posted to this funnel’s channels through Post for Me.',
    required: ['postforme_api_key', 'postforme_accounts'],
    fields: [
      { key: 'postforme_api_key', label: 'Post for Me API key', type: 'secret' },
      { key: 'postforme_accounts', label: 'Post for Me accounts', type: 'json' },
      { key: 'account_map', label: 'Account map', type: 'json' },
    ],
  },
];

/** Index of a step id, or -1. */
export function stepIndexById(id) {
  return WIZARD_STEPS.findIndex((s) => s.id === id);
}

/**
 * Is a single required key satisfied by the saved config?
 * postforme_accounts holds a JSON array; an empty array ("[]") is not complete.
 */
function keyFilled(key, cfg) {
  const v = cfg ? cfg[key] : undefined;
  if (v === undefined || v === null) return false;
  const s = String(v).trim();
  if (s === '') return false;
  if (key === 'postforme_accounts') {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) && arr.length > 0;
    } catch {
      return false;
    }
  }
  return true;
}

/** One boolean per step: all its required keys are filled (no required = done). */
export function completeness(cfg) {
  return WIZARD_STEPS.map((step) => (step.required || []).every((k) => keyFilled(k, cfg)));
}

export default { WIZARD_STEPS, stepIndexById, completeness };
