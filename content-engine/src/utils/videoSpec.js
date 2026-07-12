/**
 * Video spec helpers (pure).
 *
 * Purpose:      Deterministic building blocks for the video pipeline: MP4
 *               duration probing, seeded persona derivation, image-prompt
 *               construction, and JSON2Video movie-spec assembly.
 * Responsibility: Pure logic only; no settings, no I/O — fully unit-testable.
 * Dependencies: none.
 */

/** Parse an MP4 duration from the mvhd atom; fall back to `fallback` seconds. */
export function probeMp4DurationSeconds(buffer, fallback = 50) {
  try {
    const idx = buffer.indexOf('mvhd');
    if (idx === -1) return fallback;
    const version = buffer[idx + 4];
    if (version === 0) {
      const timescale = buffer.readUInt32BE(idx + 4 + 12);
      const duration = buffer.readUInt32BE(idx + 4 + 16);
      return timescale ? Math.round(duration / timescale) : fallback;
    }
    const timescale = buffer.readUInt32BE(idx + 4 + 20);
    const durationHi = buffer.readUInt32BE(idx + 4 + 24);
    const durationLo = buffer.readUInt32BE(idx + 4 + 28);
    const duration = durationHi * 2 ** 32 + durationLo;
    return timescale ? Math.round(duration / timescale) : fallback;
  } catch {
    return fallback;
  }
}

/** Deterministic persona from the day seed + audience keywords. */
export function seededPersona(day, audience = '') {
  const seed = Number(day) || 1;
  const genders = ['a man', 'a woman'];
  const ages = ['in their 30s', 'in their 40s', 'in their 50s'];
  const ethnicities = ['South Asian', 'East Asian', 'European', 'African', 'Latin American'];
  const a = String(audience).toLowerCase();
  let role = 'a professional';
  let setting = 'a modern office';
  if (/found|ceo|exec/.test(a)) { role = 'a company founder'; setting = 'a startup office'; }
  else if (/educ|teacher|coach/.test(a)) { role = 'an educator'; setting = 'a classroom'; }
  else if (/doctor|clinic|health/.test(a)) { role = 'a doctor'; setting = 'a clinic'; }
  else if (/parent/.test(a)) { role = 'a parent'; setting = 'a home'; }
  return {
    gender: genders[seed % genders.length],
    age: ages[seed % ages.length],
    ethnicity: ethnicities[seed % ethnicities.length],
    role,
    setting,
  };
}

/** Four consistent-person image prompts for the pipeline. */
export function buildVideoImagePrompts(persona) {
  const who = `${persona.gender} ${persona.age}, ${persona.ethnicity}, ${persona.role}`;
  return [
    `Empty B-roll of ${persona.setting}, cinematic, no people, vertical 9:16.`,
    `${who}, weary close-up, soft window light, photorealistic, vertical 9:16, consistent person.`,
    `${who}, weary, looking out a window in profile, photorealistic, vertical 9:16, same person.`,
    `${who}, calm and relieved, gentle smile, warm light, photorealistic, vertical 9:16, same person.`,
  ];
}

/** Build a JSON2Video movie spec (1080x1920) from a voiceover + images. */
export function buildMovieSpec({ voiceoverUrl, imageUrls, durationSeconds, ctaTime, sthiraTime }) {
  const scenes = [];
  const per = Math.max(3, Math.round(durationSeconds / Math.max(1, imageUrls.length)));
  imageUrls.forEach((url, i) => {
    scenes.push({ duration: per, elements: [{ type: 'image', src: url, zoom: i % 2 === 0 ? 2 : -2 }] });
  });
  if (sthiraTime) {
    scenes.push({ duration: 4, elements: [{ type: 'text', text: 'Sthira', settings: { 'font-family': 'Poppins', 'font-size': 150 } }] });
  }
  scenes.push({
    duration: 4,
    elements: [{ type: 'text', text: 'Take the Assessment', settings: { 'font-family': 'Poppins', 'font-size': 90, color: '#E8B23A' } }],
  });
  return {
    resolution: 'custom',
    width: 1080,
    height: 1920,
    elements: [{ type: 'audio', src: voiceoverUrl }],
    scenes,
    settings: { subtitles: { style: 'classic', 'font-size': 92 } },
    meta: { ctaTime, sthiraTime },
  };
}

export default { probeMp4DurationSeconds, seededPersona, buildVideoImagePrompts, buildMovieSpec };
