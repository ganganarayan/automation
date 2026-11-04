/**
 * The comparison facts the Settings field starts with (plain data).
 *
 * Extracted from the Assess360 comparison pages (Assessment repo,
 * src/content/seo/pages/*-alternative.ts): only rows where the competitor plainly
 * lacks the feature, or both have it. Rows that favour the competitor, or say only
 * "not documented", are left out, so read this as what a thumbnail may claim and
 * not as the whole comparison. Editable under System prompts, where saved text wins.
 */
export const DEFAULT_COMPARISON_BRAND = 'Assess360';

export const DEFAULT_COMPARISONS = `Fillout (checked 27-10-2026)
Server-side Conversions API | yes | no
Qualified-only conversion event | yes | no
More than one outcome page | yes | yes
Conditional logic | yes | yes
Custom domain | yes | yes
Webhooks and export | yes | yes

Google Forms (checked 27-10-2026)
Points per answer option | yes | no
Named score bands and a result per band | yes | no
Anything at all reported to an ad platform | yes | no
Custom domain and your branding | yes | no
Conditional logic | yes | yes
Answers survive a closed tab | yes | yes
Export and a place to read the data | yes | yes

Interact (checked 27-10-2026)
Custom domain | yes | no
Gate runs before the opt-in | yes | no
Server-side Conversions API | yes | no
Webhooks | yes | no
Branded PDF report | yes | no
Points per answer | yes | yes
Score ranges choosing a result | yes | yes

involve.me (checked 27-10-2026)
Server-side Conversions API | yes | no
Qualified-only conversion event | yes | no
Named score bands | yes | yes
More than one outcome page | yes | yes
Custom domain | yes | yes

Jotform (checked 27-10-2026)
Gate runs before the opt-in | yes | no
Server-side Conversions API | yes | no
Qualified-only conversion event | yes | no
Conditional logic | yes | yes
Webhooks and CSV export | yes | yes

LeadQuizzes (checked 27-10-2026)
Gate runs before the opt-in | yes | no
Server-side Conversions API | yes | no
Qualified-only conversion event | yes | no
Points per answer | yes | yes
Score ranges choosing a result | yes | yes
More than one outcome | yes | yes
Conditional logic | yes | yes
Webhooks | yes | yes
The result emailed to the respondent | yes | yes

Marquiz (checked 27-10-2026)
Gate runs before the opt-in | yes | no
Qualified-only conversion event | yes | no
Server-side Conversions API | yes | yes
Points per answer | yes | yes
Score ranges choosing a result | yes | yes
Conditional logic | yes | yes
Webhooks | yes | yes
Custom domain | yes | yes

Outgrow (checked 27-10-2026)
Qualified-only conversion event | yes | no
More than one outcome page | yes | yes
Conditional logic | yes | yes
Answers survive a closed tab | yes | yes

Paperform (checked 27-10-2026)
Gate runs before the opt-in | yes | no
Server-side Conversions API | yes | no
Qualified-only conversion event | yes | no
More than one outcome page | yes | yes
Conditional logic | yes | yes
Custom domain | yes | yes
Webhooks and export | yes | yes

Riddle (checked 27-10-2026)
Custom domain | yes | no
Gate runs before the opt-in | yes | no
Server-side Conversions API | yes | no
Does the pixel work on a hosted link? | yes | no
Qualified-only conversion event | yes | no
Branded PDF report | yes | no
Percentage bands choosing a result | yes | yes
Result page built from blocks | yes | yes
Conditional logic | yes | yes
Webhooks and export | yes | yes

ScoreApp (checked 27-10-2026)
Gate runs before the opt-in | yes | no
Qualified-only conversion event | yes | no
Exclusion audience for the people turned away | yes | no
Server-side Conversions API | yes | yes
Weighted scoring and category subscores | yes | yes
Score bands and more than one result page | yes | yes
Branded PDF report | yes | yes
Custom domain | yes | yes

SurveyMonkey (checked 27-10-2026)
Gate runs before the opt-in | yes | no
Server-side Conversions API | yes | no
Scoring and routing at the same time | yes | no
Points per answer | yes | yes
Named score bands | yes | yes
Skip logic and branching | yes | yes
Webhooks and export | yes | yes

Typeform (checked 27-10-2026)
Server-side Conversions API | yes | no
Qualified-only conversion event | yes | no
Exclusion audience for the people turned away | yes | no
Points per answer, and logic | yes | yes
Score ranges choosing a different outcome | yes | yes
Branding removed | yes | yes
Webhooks and CSV export | yes | yes`;

export default { DEFAULT_COMPARISON_BRAND, DEFAULT_COMPARISONS };
