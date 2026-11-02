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
 * select | secret | json | textarea (driveFolder: true stores a pasted folder
 * link as its ID), plus { type: 'ready_videos' } for Lane 1's video list and
 * { type: 'heading', label } for a section title (neither has a key or is
 * saved). The publish step's postforme_* fields are rendered by the
 * account-picker widgets, keyed by name.
 *
 * Values persist to funnel_config as flat keys; downstream pipeline steps read
 * them. Building the wizard shell (this step) does not wire the providers, a
 * saved field is just stored config until its stage is built.
 */

/** Clip lengths offered for Lane 2 (animationSpec.clipSeconds clamps to these). */
export const CLIP_SECONDS = [5, 6, 7, 8, 9, 10];

export const WIZARD_STEPS = [
  {
    id: 'basics',
    title: 'Shared basics',
    icon: 'ti-adjustments',
    desc: 'Set once for every lane. Each day the router picks the lane itself: a ready video from Drive first, else an AI video when there is credit, else an image post. It then lines up the content and emails you for approval. You only fill in each lane’s details on the next pages.',
    required: ['approval_email', 'cta_link'],
    fields: [
      { key: 'approval_email', label: 'Approval email' },
      { key: 'cta_link', label: 'CTA / assessment link' },
      { key: 'landing_page_url', label: 'Landing page links (one per line)', type: 'textarea', placeholder: 'https://…\nhttps://…', help: 'The router researches new topics (AI video, image posts) from all of these pages.' },
      { key: 'audience_prefix', label: 'Audience prefix (caption line, optional)' },
      { key: 'drive_folder_id', label: 'Drive media folder for this funnel', driveFolder: true, placeholder: 'folder link or ID', help: 'AI videos and stills are saved here. Also the ready-video folder when Lane 1 has none of its own.' },
      { key: 'publish_time', label: 'Publish time (IST)', type: 'time', default: '08:02' },
      { key: 'generate_days', label: 'Days to post (blank = every day)', type: 'weekdays' },
      { key: 'generate_time', label: 'Prepare time (IST)', type: 'time', default: '22:00', help: 'The older per-funnel trigger. The router also checks every afternoon at the router check time on the settings page.' },
    ],
  },
  {
    id: 'ready',
    title: 'Lane 1: Ready video',
    icon: 'ti-video',
    desc: 'First choice every day. The router takes the oldest unposted video in this Drive folder. A same-name .jpg/.png and .txt next to it are used as its thumbnail and caption, and it is scheduled with no approval; otherwise it is transcribed, the AI writes the copy and thumbnail, and you get one approval email.',
    requiredFn: readyRequired,
    fields: [
      { key: 'direct_drive_folder', label: 'Drive folder of ready videos (blank = the funnel media folder)', driveFolder: true, placeholder: 'folder link or ID' },
      { type: 'ready_videos', label: 'Videos in the folder' },
      { key: 'direct_copy_brief', label: 'AI copy: brand / voice brief (title, description, captions for each video)', type: 'textarea', placeholder: 'e.g. calm, practical tone; speak to founders; always use #gitawisdom' },
      { key: 'direct_caption', label: 'Fallback caption (Instagram & LinkedIn caption, YouTube description; the CTA link is appended)', type: 'textarea', placeholder: 'default caption for these posts' },
      { key: 'direct_yt_title', label: 'Fallback YouTube title', placeholder: 'title shown on YouTube' },
    ],
  },
  {
    id: 'ai',
    title: 'Lane 2: AI video',
    icon: 'ti-movie',
    desc: 'Used when no ready video is waiting and there is credit. The router researches a topic from the landing page and past posts, writes the script and emails it for approval; then stills, animation, narration and the stitched reel follow, with a second approval before posting. Provider keys live on the Keys and credit page.',
    required: ['voice_id'],
    fields: [
      { type: 'heading', label: 'Script' },
      { key: 'script_tone', label: 'Tone & rules', type: 'textarea', placeholder: 'length (~220 words), voice, do / don’t, CTA style' },
      { type: 'heading', label: 'Images' },
      {
        key: 'image_provider', label: 'Image model', type: 'select', default: 'auto',
        options: [
          { value: 'auto', label: 'Auto: OpenAI if its key is set, else Gemini' },
          { value: 'openai', label: 'OpenAI' },
          { value: 'gemini', label: 'Gemini' },
        ],
      },
      { key: 'image_count', label: 'Images per video', placeholder: 'e.g. 12' },
      { key: 'image_style', label: 'Image style prompt', type: 'textarea', placeholder: 'look, palette, composition, consistency notes' },
      { type: 'heading', label: 'Image to video' },
      {
        key: 'animation_provider', label: 'Animation provider', type: 'select', default: 'kling',
        options: [
          { value: 'kling', label: 'Kling: standard (cheapest)' },
          { value: 'runway', label: 'Runway Gen-4' },
          { value: 'hailuo', label: 'Hailuo / MiniMax' },
        ],
      },
      {
        // The daily router's AI video uses the first of these with credit.
        key: 'video_provider_order', label: 'Provider order (first with credit is used)', placeholder: 'e.g. kling, runway, hailuo (blank = the provider above first)',
      },
      {
        key: 'clip_length', label: 'Clip length', type: 'select', default: '5',
        options: [
          ...CLIP_SECONDS.map((n) => ({ value: String(n), label: `${n} seconds` })),
        ],
        help: 'Kling and Runway make 5 or 10 second clips (Hailuo 6 or 10). A length in between is made at the next size up, billed at that size, and trimmed when stitched.',
      },
      {
        key: 'motion', label: 'Motion', type: 'select', default: 'subtle',
        options: [
          { value: 'subtle', label: 'Subtle drift' },
          { value: 'cinematic', label: 'Cinematic' },
          { value: 'energetic', label: 'Energetic' },
        ],
      },
      { type: 'heading', label: 'Voiceover' },
      {
        key: 'tts_provider', label: 'Narrator provider', type: 'select', default: 'elevenlabs',
        options: [
          { value: 'elevenlabs', label: 'ElevenLabs' },
          { value: 'heygen', label: 'HeyGen' },
        ],
      },
      { key: 'voice_id', label: 'Voice', type: 'voice_select', placeholder: 'the cloned voice to use' },
      { type: 'heading', label: 'Final reel' },
      {
        key: 'aspect', label: 'Aspect ratio', type: 'select', default: '9:16',
        options: [
          { value: '9:16', label: '9:16 (reels / shorts)' },
          { value: '1:1', label: '1:1 (square)' },
          { value: '16:9', label: '16:9 (landscape)' },
        ],
      },
      {
        key: 'burn_captions', label: 'Caption burn-in', type: 'select', default: 'on',
        options: [
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
      },
      {
        key: 'manual_stepper', label: 'Run mode', type: 'select', default: 'off',
        options: [
          { value: 'off', label: 'Automatic: the router runs every stage' },
          { value: 'on', label: 'Manual: I run each stage by hand (Execute, Preview, Approve, next)' },
        ],
      },
    ],
  },
  {
    id: 'image',
    title: 'Lane 3: Image post',
    icon: 'ti-photo',
    desc: 'The fail-safe, so the funnel always posts. The router takes the next Ready row of this sheet (and tops the sheet up from the landing page when fewer than 2 are left), makes the image and emails it for approval.',
    required: ['sheet_id'],
    fields: [
      { key: 'sheet_id', label: 'Content sheet ID' },
      { key: 'sheet_tab', label: 'Sheet tab name (blank = first tab)', placeholder: 'e.g. Sheet1 / Content' },
      {
        key: 'image_size', label: 'Image size (image posts and AI video stills)', type: 'select', default: 'portrait',
        options: [
          { value: 'portrait', label: 'Portrait (2:3)' },
          { value: 'square', label: 'Square (1:1)' },
        ],
      },
      {
        key: 'image_when', label: 'Older sheet poster (at the prepare time)', type: 'select', default: 'no_video',
        options: [
          { value: 'no_video', label: 'Only on days with no video scheduled' },
          { value: 'always', label: 'Every run, even when a video posts that day' },
        ],
      },
    ],
  },
  {
    id: 'publish',
    title: 'Publish & comments',
    icon: 'ti-send',
    desc: 'Shared by every lane: the connected accounts this funnel posts to through Post for Me (the API key lives on the Keys and credit page), and the optional comment-to-DM.',
    required: ['postforme_accounts'],
    fields: [
      { key: 'postforme_accounts', label: 'Post for Me accounts', type: 'json' },
      { key: 'account_map', label: 'Account map', type: 'json' },
      // Comment-to-DM for this funnel's Instagram/Facebook posts (optional).
      { key: 'capture_keyword', label: 'Auto-DM keyword on comments (blank = off)', placeholder: 'e.g. guide' },
      { key: 'capture_dm_text', label: 'Auto-DM message', type: 'textarea' },
      { key: 'capture_dm_link', label: 'Auto-DM link' },
      { key: 'capture_public_replies', label: 'Public reply variants (one per line)', type: 'textarea' },
      {
        key: 'capture_require_follow', label: 'Require them to follow before sending the link', type: 'select', default: 'off',
        options: [
          { value: 'off', label: 'Off: send the link to everyone who replies' },
          { value: 'on', label: 'On: only followers get the link (Instagram only)' },
        ],
      },
      { key: 'capture_followup_text', label: 'Follow-up sent when they reply (and qualify)', type: 'textarea' },
      { key: 'capture_not_following_text', label: 'Message when they do NOT follow yet', type: 'textarea' },
    ],
  },
];

/**
 * Lane 1 needs a folder: its own, or the funnel media folder it falls back to
 * (readyPostService reads direct_drive_folder, then drive_folder_id).
 */
export function readyRequired(cfg) {
  return String((cfg && cfg.direct_drive_folder) || '').trim() ? [] : ['drive_folder_id'];
}

/** A step's saveable fields (section headings carry no key). */
export function stepFields(step) {
  return ((step && step.fields) || []).filter((f) => f && f.key);
}

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
  return WIZARD_STEPS.map((step) => {
    const keys = typeof step.requiredFn === 'function' ? step.requiredFn(cfg) : step.required || [];
    return keys.every((k) => keyFilled(k, cfg));
  });
}

export default { WIZARD_STEPS, stepIndexById, completeness, stepFields, readyRequired };
