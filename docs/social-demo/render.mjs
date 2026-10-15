/** Offline media export. Reuses the repository's Chrome launcher; never visits a real AgentDrop server. */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../../scripts/lib/smoke-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const plan = JSON.parse(await readFile(resolve(here, 'plan.json'), 'utf8'));
const out = resolve(repo, 'tmp/social-demo');
await mkdir(resolve(out, 'frames'), { recursive: true });
const browser = await launchChrome();
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: plan.width, height: plan.height },
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === 'http://127.0.0.1:4392' ? route.continue() : route.abort();
  });
  await page.goto('http://127.0.0.1:4392');
  await page.waitForFunction(() => typeof window.seek === 'function');
  const seek = async (time) => {
    await page.evaluate(async (t) => window.seek(t), time);
    if (time >= 10 && time < 13) {
      await page.getByRole('button', { name: /from Wang @wang/ }).waitFor();
      if (time >= 10.5) {
        await page.getByText('Attachments · downloads').waitFor();
        await page.getByText('results.csv', { exact: true }).waitFor();
        await page.getByText('notes.md', { exact: true }).waitFor();
        await page.evaluate(async (t) => window.seek(t), time);
        if (time >= 11.4) {
          const visible = await page.evaluate(() => {
            const pane = document.querySelector('section[aria-label="Message"]');
            const bounds = pane.getBoundingClientRect();
            return ['results.csv', 'notes.md'].every((name) => {
              const tile = pane.querySelector(`[title="${name}"]`);
              const rect = tile.getBoundingClientRect();
              return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
            });
          });
          if (!visible) throw new Error('Attachment names are outside the visible message viewport');
        }
      }
    }
    const shot = plan.shots.find((item) => time >= item.start && time < item.end);
    if ((await page.locator('main').getAttribute('data-shot')) !== shot?.id)
      throw new Error('Wrong shot after seek');
    await page
      .getByText('Illustrative product walkthrough · fictional people & data', { exact: true })
      .waitFor();
    if (time >= 13) await page.getByText('github.com/Interwork-ai/agentdrop', { exact: true }).waitFor();
    if (time >= 4.1 && time < 6) await page.getByText('Delivered to Alice', { exact: true }).waitFor();
    if (time >= 7.5 && time < 10)
      await page.getByText('From Wang · Ablation results, run 14', { exact: true }).waitFor();
  };
  // Seek both ways so exports cannot depend on an earlier playback.
  for (const time of [0, 1.5, 3, 5, 8.5, 10.2, 11.5, 14, 11.5, 10.2, 5]) {
    await seek(time);
    await page.screenshot({ path: resolve(out, `still-${time}.png`) });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  if (process.argv.includes('--stills')) {
    console.log('Eleven forward and reverse keyframe seeks checked.');
  } else {
    for (let frame = 0; frame < plan.duration * plan.fps; frame++) {
      await seek(frame / plan.fps);
      await page.screenshot({
        path: resolve(out, 'frames', `${String(frame).padStart(5, '0')}.jpg`),
        type: 'jpeg',
        quality: 94,
      });
      if (frame % (plan.fps * 4) === 0) console.log(`Rendered ${frame / plan.fps}s / ${plan.duration}s`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const master = resolve(out, 'master.wav');
    const mp4 = resolve(repo, 'docs/images/agentdrop-social.mp4');
    const gif = resolve(repo, 'docs/images/agentdrop-social.gif');
    const ffmpeg = (args) => {
      const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
        stdio: 'inherit',
      });
      if (result.status !== 0) throw new Error('FFmpeg export failed.');
    };
    ffmpeg([
      '-framerate',
      String(plan.fps),
      '-i',
      resolve(out, 'frames/%05d.jpg'),
      '-i',
      master,
      '-c:v',
      'libx264',
      '-crf',
      '20',
      '-preset',
      'medium',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      '-t',
      String(plan.duration),
      mp4,
    ]);
    // Include the hook and repository CTA in the silent social loop.
    ffmpeg([
      '-ss',
      '0',
      '-t',
      '15',
      '-i',
      mp4,
      '-filter_complex',
      'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop',
      '0',
      gif,
    ]);
    console.log('Exported 15-second social GIF and H.264/AAC video.');
  }
} finally {
  await browser.close();
}
