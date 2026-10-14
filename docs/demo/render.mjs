/** Offline media export. Reuses the repository's Chrome launcher; never visits a real AgentDrop server. */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../../scripts/lib/smoke-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const plan = JSON.parse(await readFile(resolve(here, 'plan.json'), 'utf8'));
const out = resolve(repo, 'tmp/readme-demo');
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
    return url.origin === 'http://127.0.0.1:4391' ? route.continue() : route.abort();
  });
  await page.goto('http://127.0.0.1:4391');
  await page.waitForFunction(() => typeof window.seek === 'function');
  const seek = async (time) => {
    await page.evaluate(async (t) => window.seek(t), time);
    if (time >= 20 && time < 29) {
      await page.getByRole('button', { name: /from Wang @wang/ }).waitFor();
      if (time >= 22) {
        await page.getByText('Attachments · downloads').waitFor();
        await page.getByText('results.csv', { exact: true }).waitFor();
        await page.getByText('notes.md', { exact: true }).waitFor();
        await page.evaluate(async (t) => window.seek(t), time);
      }
    }
  };
  // Seek both ways so exports cannot depend on an earlier playback.
  for (const time of [24, 21, 16, 9, 1, 32, 24]) {
    await seek(time);
    await page.screenshot({ path: resolve(out, `still-${time}.png`) });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  if (process.argv.includes('--stills')) {
    console.log('Seven key frames and reverse seeks checked.');
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
    const mp4 = resolve(repo, 'docs/images/agentdrop-demo.mp4');
    const gif = resolve(repo, 'docs/images/agentdrop-demo.gif');
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
    // Start with a readable send request, then loop through receive and the real inbox. No blank title frames.
    ffmpeg([
      '-ss',
      '5.8',
      '-t',
      '23',
      '-i',
      mp4,
      '-filter_complex',
      'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop',
      '0',
      gif,
    ]);
    console.log('Exported README GIF and H.264/AAC video.');
  }
} finally {
  await browser.close();
}
