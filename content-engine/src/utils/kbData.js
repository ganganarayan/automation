/**
 * Knowledge base articles (public, no sign-in).
 *
 * Purpose:      Question-led help articles that answer what buyers and users
 *               ask, written so a search engine or an AI assistant can lift
 *               the answer whole: the question is the title, a one or two
 *               sentence answer comes first, and every section heading is a
 *               question with its own short answer.
 * Responsibility: Pure data. Only features that are built and in the app.
 *               A price is never typed here: it comes from planSpec, per currency.
 * Dependencies: utils/planSpec (prices), pure.
 *
 * Shape of an article:
 *   { slug, topic, question, short, keywords[], related[slug], updated 'YYYY-MM-DD',
 *     sections: [{ q, a, p[], bullets[] }] }
 */

import { PLANS, EXTRAS } from './planSpec.js';

/** The topics, in the order the KB index shows them. */
export const KB_TOPICS = [
  { id: 'start', title: 'Getting started', blurb: 'What the app is, and your first funnel.' },
  { id: 'daily', title: 'Posting every day', blurb: 'How the daily router picks and publishes a post.' },
  { id: 'approve', title: 'Approving and checking posts', blurb: 'Nothing goes out without you.' },
  { id: 'channels', title: 'Channels and publishing', blurb: 'Where posts go, and what happens when one fails.' },
  { id: 'leads', title: 'Comments into leads', blurb: 'Comment-to-DM, personal links and calls to action.' },
  { id: 'ai', title: 'AI and cost', blurb: 'Which AI does what, and what each post really cost.' },
  { id: 'account', title: 'Plans, agencies and privacy', blurb: 'Price, cancelling, clients and your Google Drive.' },
];

const rupees = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const dollars = (n) => (Number(n) % 1 ? `$${Number(n).toFixed(2)}` : `$${Number(n || 0).toLocaleString('en-US')}`);

/** Every article. Prices are filled in for the visitor's currency ('inr' or 'usd'). */
export function kbArticles(cur = 'inr') {
  const usd = cur === 'usd';
  const brand = usd ? `${dollars(PLANS.brand.priceUsd)} a month` : `${rupees(PLANS.brand.priceInr)} + GST a month`;
  const client = usd ? `${dollars(PLANS.agency.unit.priceUsd)} a month` : `${rupees(PLANS.agency.unit.priceInr)} + GST a month`;
  const posts30 = usd ? dollars(EXTRAS.posts30.usd) : `${rupees(EXTRAS.posts30.inr)} + GST`;
  const aiVideo = usd ? dollars(EXTRAS.aiVideo.usd) : `${rupees(EXTRAS.aiVideo.inr)} + GST`;
  const user = usd ? dollars(EXTRAS.user.usd) : `${rupees(EXTRAS.user.inr)} + GST`;

  return [
    // Getting started
    {
      slug: 'what-is-content-engine',
      topic: 'start',
      question: 'What is Content Engine?',
      short: 'Content Engine is a social media app that makes a finished post every day (copy, pictures in every size and a voiced video), publishes it to up to 10 channels from one approval, and turns comments into leads with comment-to-DM.',
      keywords: ['social media automation', 'ai content tool', 'auto post every day', 'content engine app'],
      related: ['how-do-i-set-up-my-first-funnel', 'how-does-the-daily-router-pick-a-post', 'what-is-comment-to-dm'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'How is it different from a scheduler?',
          a: 'A scheduler queues a post you already made. Content Engine makes the post, picks what goes out each day, and publishes it.',
          p: ['Tools like Buffer or Hootsuite expect you to bring the caption, the picture and the video. Content Engine writes the copy with Claude, draws the pictures with OpenAI, voices videos with ElevenLabs and posts the result. You approve; it does the rest.'],
          bullets: [],
        },
        {
          q: 'What does a finished post include?',
          a: 'A caption and hook, a picture or thumbnail in each size the platforms want, and for video posts an end card with your call to action.',
          p: [],
          bullets: ['Copy written against the background you paste for the funnel', 'Thumbnails in 16:9, 9:16 and 4:5', 'Placed text on the picture: an audience eyebrow, a headline and a sub-head', 'Your link as the first comment where the platform allows it'],
        },
      ],
    },
    {
      slug: 'how-do-i-set-up-my-first-funnel',
      topic: 'start',
      question: 'How do I set up my first funnel?',
      short: 'Sign in, connect Google Drive and your social accounts from Settings, then create a funnel: give it a name, paste your business background, pick its channels, a call to action and a Daily time (19:00 by default).',
      keywords: ['set up funnel', 'getting started', 'onboarding', 'connect social accounts'],
      related: ['what-is-a-funnel', 'what-order-do-my-ready-videos-post-in', 'how-do-i-approve-posts-from-my-phone'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Is there a guided setup?',
          a: 'Yes. A help bot at the top right of the app walks you through eight steps, ending with your ready videos folder and your content sheet.',
          p: ['The sheet step gives you an Excel template and an AI prompt maker, so you can fill a month of ideas without starting from a blank page.'],
          bullets: [],
        },
        {
          q: 'Do I need a developer?',
          a: 'No. Google Drive, Gmail and your social accounts all connect from Settings inside the app.',
          p: ['There are no setup files to edit. Every key and schedule lives in the app\'s own settings.'],
          bullets: [],
        },
      ],
    },
    {
      slug: 'what-is-a-funnel',
      topic: 'start',
      question: 'What is a funnel in Content Engine?',
      short: 'A funnel is one brand or audience: it has its own name, channels, business background, call to action and Daily time, and you pay per funnel with 10 channels each.',
      keywords: ['funnel', 'brand', 'audience', 'multiple brands'],
      related: ['how-do-i-set-up-my-first-funnel', 'can-each-funnel-have-its-own-call-to-action', 'how-much-does-content-engine-cost'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'How do I know a funnel will not run dry?',
          a: 'The Funnels page shows how many ready videos, ready thumbnails and image posts are left per funnel, counted the way the router picks them.',
          p: [],
          bullets: [],
        },
        {
          q: 'Can I rename a funnel later?',
          a: 'Yes. The Funnel name field is on step 1 of the lane setup and can be changed any time.',
          p: [],
          bullets: [],
        },
      ],
    },

    // Posting every day
    {
      slug: 'how-to-post-on-social-media-every-day-without-making-content',
      topic: 'daily',
      question: 'How do I post on social media every day without making content myself?',
      short: 'Use a tool that makes the post as well as publishing it. In Content Engine a daily router picks a ready video, an AI video or an image post, makes the copy and pictures, and publishes to every channel once you approve.',
      keywords: ['post every day', 'consistent posting', 'daily social media posts', 'never miss a post', 'automate content creation'],
      related: ['how-does-the-daily-router-pick-a-post', 'what-is-content-engine', 'does-anything-post-without-my-approval'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Why do most businesses stop posting?',
          a: 'Because making the post is the slow part, not scheduling it. A scheduler still needs a caption, a picture and a video from you every day.',
          p: ['Consistency comes from removing the making step. If a post is waiting for approval each day, keeping the streak takes seconds.'],
          bullets: [],
        },
        {
          q: 'What if I have no videos at all?',
          a: 'The AI video lane writes a script, draws the pictures, animates them and voices them. The image post lane turns a picture into a voiced video with music.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'how-does-the-daily-router-pick-a-post',
      topic: 'daily',
      question: 'How does the daily router pick what to post?',
      short: 'Once a day, at the funnel\'s Daily time, the router picks a lane in order: your ready video first, then an AI video, then an image post. It always posts something.',
      keywords: ['daily router', 'lanes', 'ready video', 'ai video', 'image post', 'daily time'],
      related: ['what-order-do-my-ready-videos-post-in', 'what-happens-if-an-ai-video-fails', 'what-is-a-funnel'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'What are the three lanes?',
          a: 'Lane 1 is your own ready videos, Lane 2 makes an AI video, Lane 3 makes an image post.',
          p: [],
          bullets: ['Lane 1, Ready video: your videos from a Drive folder, with AI copy, thumbnails, an end card and the Clean check', 'Lane 2, AI video: script, pictures, animation (Kling, Runway or MiniMax Hailuo) and an ElevenLabs voice', 'Lane 3, Image post: a picture in three sizes, turned into a voiced video with your music'],
        },
        {
          q: 'What wakes the router?',
          a: 'A scheduled trigger wakes each workspace once a day at its Daily time, which is 19:00 by default.',
          p: ['If a wake is missed, the next one catches up on jobs from the last few hours, so a quiet server does not mean a missed day.'],
          bullets: [],
        },
        {
          q: 'What if I move a planned post to another day?',
          a: 'The day it left is freed, so the next wake fills it with a new pick instead of leaving a gap.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'what-order-do-my-ready-videos-post-in',
      topic: 'daily',
      question: 'What order do my ready videos post in?',
      short: 'By the serial number at the start of the file name, then A to Z. Upload date is never used, so you control the order by naming the files.',
      keywords: ['video order', 'google drive folder', 'file name order', 'ready video lane'],
      related: ['how-does-the-daily-router-pick-a-post', 'what-is-the-clean-check'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'How do I know a video has been posted?',
          a: 'Once it is live, the file in your Drive folder is renamed with POSTED, so it is never picked twice.',
          p: [],
          bullets: [],
        },
        {
          q: 'Can I write the thumbnail headline myself?',
          a: 'Yes. Type a headline for the ready video and it is used as is. Leave it blank and the AI writes one.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'what-happens-if-an-ai-video-fails',
      topic: 'daily',
      question: 'What happens if an AI video fails to animate?',
      short: 'The same post steps down to an image post made from the video\'s own still picture, so the day still gets a post.',
      keywords: ['animation failed', 'kling', 'runway', 'hailuo', 'fallback'],
      related: ['how-does-the-daily-router-pick-a-post', 'which-ai-models-does-content-engine-use'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Do image posts work on YouTube?',
          a: 'Yes. Image posts are voiced videos with music, and on YouTube they go out as a 10-second Short.',
          p: ['Music comes from one Music box in Settings: a Drive folder of tracks, each with a same-name .txt file whose credit goes on the last line of the caption.'],
          bullets: [],
        },
      ],
    },

    // Approving and checking
    {
      slug: 'does-anything-post-without-my-approval',
      topic: 'approve',
      question: 'Does anything post without my approval?',
      short: 'No. Every post waits in the Library until you press Approve, and one daily email digest tells you what is waiting.',
      keywords: ['approval', 'review before posting', 'control', 'library'],
      related: ['how-do-i-approve-posts-from-my-phone', 'what-does-disapprove-and-remake-do', 'what-is-the-clean-check'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'What is in the daily digest?',
          a: 'One email per address each evening with everything that went live, failed or waits for you, instead of an email per post.',
          p: [],
          bullets: [],
        },
        {
          q: 'Can an empty review approve a post by accident?',
          a: 'No. A script review with nothing in it is refused, so a blank click never approves a bad post.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'how-do-i-approve-posts-from-my-phone',
      topic: 'approve',
      question: 'How do I approve posts from my phone?',
      short: 'Open the app\'s Library on your phone and press Review, then Approve. Approving runs the Clean check once and schedules the post.',
      keywords: ['approve on mobile', 'phone', 'review', 'library'],
      related: ['does-anything-post-without-my-approval', 'what-is-the-clean-check'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Is a scheduled post the same as a posted one?',
          a: 'No. A post counts as live only when the platform says so, and the Log shows each channel\'s own result and link.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'what-does-disapprove-and-remake-do',
      topic: 'approve',
      question: 'What does Disapprove and Remake do?',
      short: 'You give a reason, get a one-minute hold to change your mind, then Remake or send Video corrections. The lane reruns and saves the lesson so the next post avoids the same mistake.',
      keywords: ['disapprove', 'remake', 'feedback', 'learn my voice', 'brand voice'],
      related: ['does-anything-post-without-my-approval', 'which-ai-models-does-content-engine-use'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Where do the lessons go?',
          a: 'Into Settings, under System prompts, where you can read and edit what the AI has learned.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'what-is-the-clean-check',
      topic: 'approve',
      question: 'What is the Clean check?',
      short: 'One switch for ready videos. Off posts your video as is; on has the AI check each video, including its ending in a window you choose (15 seconds by default).',
      keywords: ['clean check', 'video check', 'ai video review', 'transcript'],
      related: ['what-order-do-my-ready-videos-post-in', 'how-do-i-approve-posts-from-my-phone'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Are names and terms spelled my way?',
          a: 'Yes. Each ready video is transcribed and checked against your glossary.',
          p: [],
          bullets: [],
        },
      ],
    },

    // Channels
    {
      slug: 'which-social-media-channels-does-content-engine-post-to',
      topic: 'channels',
      question: 'Which social media channels does Content Engine post to?',
      short: 'Instagram, Facebook, YouTube, TikTok, LinkedIn, Threads, X and Pinterest, up to 10 channels per funnel, all from one approval.',
      keywords: ['instagram', 'facebook', 'youtube shorts', 'tiktok', 'linkedin', 'threads', 'x twitter', 'pinterest', 'cross posting'],
      related: ['what-happens-when-a-post-fails-on-one-channel', 'why-do-threads-and-x-get-an-image-instead-of-video', 'can-i-post-my-link-as-the-first-comment'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Does every channel get the right size?',
          a: 'Yes. Pictures and thumbnails are made in 16:9, 9:16 and 4:5, and the tall ones are drawn as their own picture rather than cropped.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'what-happens-when-a-post-fails-on-one-channel',
      topic: 'channels',
      question: 'What happens when a post fails on one channel?',
      short: 'That channel shows a red cross on the Log with the reason. Press Retry failed only and just that channel is sent again; the channels that worked are left alone.',
      keywords: ['post failed', 'retry', 'error', 'log'],
      related: ['which-social-media-channels-does-content-engine-post-to', 'how-do-i-delete-a-post-from-every-platform'],
      updated: '2026-11-12',
      sections: [],
    },
    {
      slug: 'how-do-i-delete-a-post-from-every-platform',
      topic: 'channels',
      question: 'How do I delete a post from every platform at once?',
      short: 'Tick the channels and press Delete once. The post is taken down from each platform through that platform\'s own API.',
      keywords: ['delete post', 'take down', 'remove post everywhere'],
      related: ['what-happens-when-a-post-fails-on-one-channel'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Do I lose the record of what it cost?',
          a: 'No. Deleted posts keep their cost on the Log and cost page.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'why-do-threads-and-x-get-an-image-instead-of-video',
      topic: 'channels',
      question: 'Why do Threads and X sometimes get an image instead of the video?',
      short: 'Both step down: video first, then image and text, then text. A video longer than they accept (5 minutes on Threads, 20 minutes on X) skips straight to the image.',
      keywords: ['threads video limit', 'x video limit', 'step down'],
      related: ['which-social-media-channels-does-content-engine-post-to'],
      updated: '2026-11-12',
      sections: [],
    },
    {
      slug: 'can-i-post-my-link-as-the-first-comment',
      topic: 'channels',
      question: 'Can my link be posted as the first comment automatically?',
      short: 'Yes. Your link is posted as the first comment on every channel that allows it, and the Log shows each comment\'s status.',
      keywords: ['first comment link', 'link in comments', 'instagram link'],
      related: ['what-is-comment-to-dm', 'can-each-funnel-have-its-own-call-to-action'],
      updated: '2026-11-12',
      sections: [],
    },

    // Leads
    {
      slug: 'what-is-comment-to-dm',
      topic: 'leads',
      question: 'What is comment-to-DM automation?',
      short: 'When someone comments your keyword on an Instagram or Facebook post, they automatically get a DM with a link. In Content Engine each lead gets their own personal link.',
      keywords: ['comment to dm', 'instagram dm automation', 'manychat alternative', 'keyword comments'],
      related: ['how-do-i-know-which-leads-opened-my-link', 'can-each-funnel-have-its-own-call-to-action'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Why a personal link per lead?',
          a: 'So you can see which person opened it, not just a click count.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'how-do-i-know-which-leads-opened-my-link',
      topic: 'leads',
      question: 'How do I know which leads opened my link?',
      short: 'Add Content Engine\'s small script to your landing page. Each DM\'d lead who opens their personal link is marked on the Leads page.',
      keywords: ['lead tracking', 'landing page script', 'lead visits'],
      related: ['what-is-comment-to-dm'],
      updated: '2026-11-12',
      sections: [],
    },
    {
      slug: 'can-each-funnel-have-its-own-call-to-action',
      topic: 'leads',
      question: 'Can each funnel have its own call to action?',
      short: 'Yes. Each funnel has its own call to action, any single post can override it, and different funnels can point at different landing pages.',
      keywords: ['call to action', 'cta', 'landing page per funnel'],
      related: ['what-is-a-funnel', 'can-i-post-my-link-as-the-first-comment'],
      updated: '2026-11-12',
      sections: [],
    },

    // AI and cost
    {
      slug: 'which-ai-models-does-content-engine-use',
      topic: 'ai',
      question: 'Which AI models does Content Engine use?',
      short: 'Claude writes the copy and the picture prompts, OpenAI draws the pictures, Kling, Runway or MiniMax Hailuo animate them, and ElevenLabs voices the videos.',
      keywords: ['claude', 'openai', 'kling', 'runway', 'minimax hailuo', 'elevenlabs', 'ai models'],
      related: ['do-i-need-my-own-ai-api-keys', 'how-do-i-see-what-each-post-cost'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Why are words never drawn on a face?',
          a: 'The picture is drawn with no text, then Claude places the eyebrow, headline and sub-head in the picture\'s empty space, measured so the text always fits.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'do-i-need-my-own-ai-api-keys',
      topic: 'ai',
      question: 'Do I need my own AI API keys?',
      short: 'No. The AI is included in every plan, Agency too. An agency may still add its own keys to pay those providers directly.',
      keywords: ['api keys', 'openai key', 'claude key', 'included ai'],
      related: ['which-ai-models-does-content-engine-use', 'how-much-does-content-engine-cost'],
      updated: '2026-11-12',
      sections: [],
    },
    {
      slug: 'how-do-i-see-what-each-post-cost',
      topic: 'ai',
      question: 'How do I see what each post cost in AI?',
      short: 'Every AI step records what it really cost, and the Log and cost page shows it per post. A balance strip shows what is left with each AI provider.',
      keywords: ['ai cost', 'cost per post', 'balance', 'spend'],
      related: ['which-ai-models-does-content-engine-use', 'can-an-agency-manage-several-clients'],
      updated: '2026-11-12',
      sections: [],
    },

    // Account
    {
      slug: 'how-much-does-content-engine-cost',
      topic: 'account',
      question: 'How much does Content Engine cost?',
      short: `Always-On Brand is ${brand} per funnel, with 10 channels and 30 finished posts a month, AI included. Agency is ${client} per client. Paying yearly gives 12 months for the price of 10.`,
      keywords: ['price', 'pricing', 'cost', 'plans', usd ? 'usd price' : 'gst'],
      related: ['what-is-a-funnel', 'how-do-i-cancel-content-engine', 'can-an-agency-manage-several-clients'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Is there a free trial?',
          a: 'Yes. Seven days free with every feature, and nothing is charged if you do not continue.',
          p: [],
          bullets: [],
        },
        {
          q: 'What if I need more?',
          a: 'The app tells you before you go over your plan, and you can add more.',
          p: [],
          bullets: [`30 more posts: ${posts30}`, `One AI video: ${aiVideo}`, `Another user: ${user} a month`],
        },
      ],
    },
    {
      slug: 'how-do-i-cancel-content-engine',
      topic: 'account',
      question: 'How do I cancel Content Engine?',
      short: 'In the app, open Plan and press Cancel my plan. There is no fee and no notice period, and your workspace keeps working until the end of the period you paid for.',
      keywords: ['cancel', 'cancel subscription', 'refund'],
      related: ['how-much-does-content-engine-cost'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Do I get a refund?',
          a: 'Payments are not refunded, but a double charge or a charge after cancelling is returned. The refund policy has the detail.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'can-an-agency-manage-several-clients',
      topic: 'account',
      question: 'Can an agency manage several clients in Content Engine?',
      short: 'Yes. Each client is its own workspace with its own accounts, keys and posts, kept apart, with client logins: an owner who acts or a viewer who only looks.',
      keywords: ['agency', 'clients', 'white label', 'sub accounts', 'multi brand'],
      related: ['how-much-does-content-engine-cost', 'how-do-i-see-what-each-post-cost'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Can I bill my clients for what they use?',
          a: 'Yes. Cost is recorded per client, so you can bill each client its own share.',
          p: [],
          bullets: [],
        },
      ],
    },
    {
      slug: 'what-can-content-engine-see-in-my-google-drive',
      topic: 'account',
      question: 'What can Content Engine see in my Google Drive?',
      short: 'Only the files it creates itself, through Google\'s drive.file permission. Your other files stay private.',
      keywords: ['google drive permission', 'privacy', 'drive.file', 'data'],
      related: ['how-do-i-set-up-my-first-funnel'],
      updated: '2026-11-12',
      sections: [
        {
          q: 'Is my data used to train AI?',
          a: 'No. Google user data is not sold, not used for advertising and not used to train AI models.',
          p: [],
          bullets: [],
        },
      ],
    },
  ];
}

/** One article by slug, or null. */
export function kbArticle(slug, cur = 'inr') {
  return kbArticles(cur).find((a) => a.slug === String(slug || '')) || null;
}

/** 'YYYY-MM-DD' as DD-MM-YYYY for a reader. */
export function kbDate(iso = '') {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

export default { KB_TOPICS, kbArticles, kbArticle, kbDate };
