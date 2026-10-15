import '@fontsource-variable/manrope/index.css';
import '@fontsource/ibm-plex-mono/400.css';
import './style.css';
import { ArrowRight, Check, Copy, FileSpreadsheet, FileText, MessageSquare, Terminal } from 'lucide-react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Dashboard } from '../demo/dashboard.js';
import { DEMO_BODY } from '../demo/fixtures.js';
import plan from './plan.json';

const logo = new URL('../images/logo.png', import.meta.url).href;
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const ease = (n: number) => 1 - (1 - clamp(n)) ** 3;
let setFilmTime: (time: number) => void;
let playback = 0;

function Files() {
  return (
    <div className="file-pair">
      <div>
        <FileSpreadsheet />
        <span>results.csv</span>
        <small>RESULTS</small>
      </div>
      <div>
        <FileText />
        <span>notes.md</span>
        <small>CONTEXT</small>
      </div>
    </div>
  );
}

function Conversation({ receiving, time, actionAt }: { receiving: boolean; time: number; actionAt: number }) {
  const ready = time >= actionAt;
  const reveal = ease((time - actionAt) / 0.3);
  const prompt = receiving ? 'Read Wang’s results.' : 'Send the results and notes to @alice.';
  const typed = Math.floor(clamp((time - 0.12) / 0.8) * prompt.length);
  return (
    <div className={`conversation ${receiving ? 'receiving' : ''}`}>
      <div className="window-bar">
        <Terminal size={27} />
        <span>{receiving ? 'Alice’s Claude Code' : 'Wang’s Codex'}</span>
        <i /> <small>{receiving ? 'ALICE’S WORKSPACE' : 'WANG’S WORKSPACE'}</small>
      </div>
      <div className="conversation-body">
        <div className="prompt">
          <span>›</span>
          <p>
            {prompt.slice(0, typed)}
            <i style={{ opacity: ready ? 0 : 1 }}>▍</i>
          </p>
        </div>
        <div className="answer" style={{ opacity: reveal, transform: `translateY(${(1 - reveal) * 12}px)` }}>
          <div className="receipt">
            <Check size={28} />
            {receiving ? 'From Wang · Ablation results, run 14' : 'Delivered to Alice'}
          </div>
          <p>{receiving ? DEMO_BODY : 'Ablation results, run 14'}</p>
        </div>
        <Files />
        <div className="availability" style={{ opacity: reveal }}>
          {receiving
            ? 'Attachments available · ready when you need them'
            : 'Results + explanation, in Alice’s inbox.'}
        </div>
      </div>
    </div>
  );
}

function Film() {
  const [time, setTime] = useState(0);
  setFilmTime = (t) => flushSync(() => setTime(Math.max(0, Math.min(plan.duration - 0.001, t))));
  const shot = plan.shots.find((s) => time >= s.start && time < s.end) ?? plan.shots[0];
  if (!shot) throw new Error('The film needs a shot');
  const local = time - shot.start;
  const arrival = ease(local / 0.4);
  const receiving = shot.id === 'receive';
  return (
    <main className={`film scene-${shot.id}`} data-shot={shot.id}>
      <div className="route-background">
        <span />
        <span />
        <span />
      </div>
      <header className="masthead">
        <div className="wordmark">
          <img src={logo} alt="" />
          AgentDrop
        </div>
        <span>
          {shot.id === 'hook'
            ? 'THE HUMAN RELAY'
            : shot.id === 'close'
              ? 'OPEN SOURCE · APACHE-2.0'
              : 'FROM YOUR AGENT TO THEIRS'}
        </span>
      </header>
      {shot.id === 'hook' ? (
        <section className="hook">
          <h1>
            Humans are still the <em>API</em>
            <br />
            between AI agents.
          </h1>
          <div className="manual-route">
            <div className="endpoint">
              <Terminal />
              <b>Wang’s Codex</b>
            </div>
            <ArrowRight className="route-arrow" />
            <div className={`relay-step ${local > 0.15 ? 'lit' : ''}`}>
              <Copy />
              <b>Copy</b>
              <small>the results</small>
            </div>
            <ArrowRight className="route-arrow" />
            <div className={`relay-step ${local > 0.5 ? 'lit' : ''}`}>
              <MessageSquare />
              <b>Message</b>
              <small>your teammate</small>
            </div>
            <ArrowRight className="route-arrow" />
            <div className={`relay-step ${local > 0.85 ? 'lit' : ''}`}>
              <Copy />
              <b>Paste</b>
              <small>the context</small>
            </div>
            <ArrowRight className="route-arrow" />
            <div className="endpoint">
              <Terminal />
              <b>Alice’s Claude Code</b>
            </div>
          </div>
          <div className="manual-underline" style={{ width: `${ease(local / 1.6) * 100}%` }} />
        </section>
      ) : shot.id === 'send' || receiving ? (
        <section className="handoff-scene">
          <div
            className="editorial"
            style={{ transform: `translateX(${(1 - arrival) * -24}px)`, opacity: 0.5 + 0.5 * arrival }}
          >
            <div className="kicker">{receiving ? '02 / THE PICKUP' : '01 / THE HANDOFF'}</div>
            <h2>
              {receiving ? (
                <>
                  Pick it up
                  <br />
                  in <em>Claude.</em>
                </>
              ) : (
                <>
                  Send it
                  <br />
                  to <em>Alice.</em>
                </>
              )}
            </h2>
            <p>
              {receiving ? (
                <>
                  Her agent.
                  <br />
                  Your context.
                </>
              ) : (
                <>
                  Your results.
                  <br />
                  Her next step.
                </>
              )}
            </p>
            <div className="people-route">
              <span className={receiving ? '' : 'current'}>Wang</span>
              <ArrowRight />
              <span className={receiving ? 'current' : ''}>Alice</span>
            </div>
          </div>
          <Conversation receiving={receiving} time={local} actionAt={shot.actions[0]?.at ?? 0} />
        </section>
      ) : shot.id === 'dashboard' ? (
        <section className="inbox-scene">
          <div className="inbox-heading">
            <h2>
              Files + context, <em>together.</em>
            </h2>
            <span>Alice’s inbox</span>
          </div>
          <div className="dashboard-frame">
            <div className="dashboard-scale">
              <Dashboard open={local >= (shot.actions[0]?.at ?? 0)} />
            </div>
          </div>
        </section>
      ) : (
        <section className="closing">
          <div className="close-brand" style={{ transform: `translateY(${(1 - arrival) * 18}px)` }}>
            <img src={logo} alt="" />
            <h1>AgentDrop</h1>
            <span>Open source</span>
          </div>
          <h2>
            From your agent
            <br />
            to theirs.
          </h2>
          <div className="repository">
            github.com/Interwork-ai/agentdrop
            <ArrowRight size={38} />
          </div>
        </section>
      )}
      <footer>
        <span>Illustrative product walkthrough · fictional people & data</span>
        <span>
          {shot.id === 'close' ? 'CODE + SELF-HOSTING GUIDE ON GITHUB' : 'RESULTS / FILES / CONTEXT'}
        </span>
      </footer>
      <div className="progress" style={{ width: `${(time / plan.duration) * 100}%` }} />
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Film />);
async function settle(time: number) {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await document.fonts.ready;
  const pane = document.querySelector<HTMLElement>('section[aria-label="Message"]');
  const dashboard = plan.shots.find((s) => s.id === 'dashboard');
  if (pane && dashboard) pane.scrollTop = 230 * ease((time - dashboard.start - 0.7) / 0.65);
}
Object.assign(window, {
  seek: async (time: number) => {
    playback++;
    setFilmTime(time);
    await settle(time);
  },
  playFilm: async () => {
    const token = ++playback;
    const start = performance.now();
    const frame = () => {
      if (token !== playback) return;
      const time = (performance.now() - start) / 1000;
      setFilmTime(time);
      void settle(time);
      if (time < plan.duration) requestAnimationFrame(frame);
    };
    frame();
  },
});
