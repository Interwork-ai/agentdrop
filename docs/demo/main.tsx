import '@fontsource-variable/manrope';
import '@fontsource/ibm-plex-mono/400.css';
import './style.css';
import { Check, FileSpreadsheet, FileText, Inbox, Terminal } from 'lucide-react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './dashboard.js';
import plan from './plan.json';

const logo = new URL('../images/logo.png', import.meta.url).href;
const shots = plan.shots;
let seekFilm: (t: number) => void;

function Files() {
  return (
    <div className="files">
      <span>
        <FileSpreadsheet size={24} />
        results.csv
      </span>
      <span>
        <FileText size={24} />
        notes.md
      </span>
    </div>
  );
}

function Conversation({ receiving, local }: { receiving: boolean; local: number }) {
  const prompt = receiving
    ? 'Read the ablation results from Wang.'
    : 'Send the ablation results, results.csv and notes.md to @alice.';
  const count = Math.min(prompt.length, Math.floor(Math.max(0, local - 0.4) * 42));
  const ready = local >= (receiving ? 3 : 4);
  return (
    <div className="conversation">
      <div className="terminal-bar">
        <Terminal size={27} />
        <b>{receiving ? 'Alice' : 'Wang'}</b>
        <span>{receiving ? 'Claude Code' : 'Codex CLI'}</span>
        <small>Illustrative conversation</small>
      </div>
      <div className="terminal-body">
        <div className="prompt">
          <span className="prompt-arrow">›</span>
          <p>
            {prompt.slice(0, count)}
            <span className="caret" style={{ opacity: ready ? 0 : 1 }}>
              ▍
            </span>
          </p>
        </div>
        <div
          className="answer"
          style={{ opacity: ready ? 1 : 0, transform: `translateY(${ready ? 0 : 12}px)` }}
        >
          <div className="answer-title">
            <Check size={28} />
            {receiving ? 'Wang sent “Ablation results, run 14”.' : 'Delivered to Alice'}
          </div>
          <p>
            {receiving
              ? 'Run 14 beats the baseline on three of four splits. Please check split C before Friday.'
              : 'Ablation results, run 14'}
          </p>
          <Files />
          {receiving ? (
            <div className="download-note">Two attachments available. Nothing downloaded yet.</div>
          ) : (
            <div className="download-note">The result is waiting in Alice’s inbox.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Film() {
  const [time, setTime] = useState(0);
  seekFilm = (t) => flushSync(() => setTime(Math.max(0, Math.min(plan.duration - 0.001, t))));
  const shot = shots.find((s) => time >= s.start && time < s.end) ?? shots[0];
  if (!shot) throw new Error('Demo plan needs a shot');
  const local = time - shot.start;
  const enter = shot.id === 'intro' ? 1 : Math.min(1, 0.2 + local / 0.4);
  const chapter = shots.indexOf(shot);
  return (
    <main className="film">
      <header className="brand">
        <img src={logo} alt="" />
        <b>AgentDrop</b>
        <span>A shared mailbox for coding agents</span>
      </header>
      <div className="chapters">
        {['The handoff', 'Send', 'Receive', 'Open', 'Get started'].map((label, i) => (
          <span key={label} className={i === chapter ? 'active' : ''}>
            <i>{String(i + 1).padStart(2, '0')}</i>
            {label}
          </span>
        ))}
      </div>
      <section
        className={`scene ${shot.id}`}
        style={{ opacity: enter, transform: `translateY(${(1 - enter) * 16}px)` }}
      >
        {shot.id === 'intro' ? (
          <>
            <div className="eyebrow">CODEX → CLAUDE CODE → YOUR INBOX</div>
            <h1>
              Your agent’s work.
              <br />
              <em>In their inbox.</em>
            </h1>
            <p className="subtitle">
              Send results, files and context.
              <br />
              Pick them up where the next person works.
            </p>
            <div className="handoff">
              <div>
                <Terminal />
                <b>Wang</b>
                <span>Codex CLI</span>
              </div>
              <div className="delivery-line">
                <span>results.csv + notes.md</span>
                <i />
              </div>
              <div>
                <Inbox />
                <b>Alice</b>
                <span>Claude Code</span>
              </div>
            </div>
          </>
        ) : shot.id === 'send' || shot.id === 'receive' ? (
          <>
            <div className="eyebrow">
              {shot.id === 'send' ? '01 / ASK YOUR AGENT' : '02 / CONTINUE IN ANOTHER AGENT'}
            </div>
            <h2>{shot.headlineEn}</h2>
            <p className="subtitle">
              {shot.id === 'send'
                ? 'Choose a person. Keep the files and explanation together.'
                : 'Different agent. Different machine. The context comes with it.'}
            </p>
            <Conversation receiving={shot.id === 'receive'} local={local} />
          </>
        ) : shot.id === 'dashboard' ? (
          <>
            <div className="eyebrow">03 / OPEN THE INBOX</div>
            <h2>{shot.headlineEn}</h2>
            <p className="subtitle">Read the message and see its attachments in the web dashboard.</p>
            <div className="dashboard-frame">
              <div className="dashboard-scale">
                <Dashboard open={local >= 2} />
              </div>
            </div>
          </>
        ) : (
          <>
            <img className="close-logo" src={logo} alt="AgentDrop" />
            <h1>Keep the work moving.</h1>
            <p className="subtitle">A shared mailbox for your agents and your team.</p>
            <code className="install">npm install -g agentdrop-cli</code>
            <div className="clients">
              Codex CLI <i /> Claude Code <i /> opencode <i /> Cursor <i /> oh-my-pi
            </div>
            <div className="repo">github.com/Interwork-ai/agentdrop</div>
          </>
        )}
      </section>
      <footer>
        <span>Workflow demo · fictional people and data</span>
        <span>
          {shot.id === 'close'
            ? 'Open source · Apache-2.0 · Self-hosted'
            : 'One message. The context travels with it.'}
        </span>
      </footer>
      <div className="progress" style={{ width: `${(time / plan.duration) * 100}%` }} />
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Film />);
Object.assign(window, {
  seek: async (t: number) => {
    seekFilm(t);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await document.fonts.ready;
    const pane = document.querySelector<HTMLElement>('section[aria-label="Message"]');
    if (pane) pane.scrollTop = Math.min(180, Math.max(0, (t - 23) * 180));
  },
  playFilm: async () => {
    const start = performance.now();
    const frame = () => {
      const t = (performance.now() - start) / 1000;
      seekFilm(t);
      if (t < plan.duration) requestAnimationFrame(frame);
    };
    frame();
  },
});
