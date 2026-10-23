// Anonymized incident regression and synthetic controls, labelled by the developer.
import type { TaskMode } from '../src/types.js';
// Expected outcomes never enter the model input.
type RecordingState = 'previously-ended' | 'final-flush';
export interface TriggerInput { arrivalOffsetsMs?: number[]; finalWaitMs?: number; chunkSpeakers?: string[][]; chunkSpeakerIds?: number[][]; control?: 'send' | 'cancel'; source?: 'dictation'; recordingState?: RecordingState; name: string; prior: string; chunks: string[][] }
export interface TriggerExpected { lastTurn?: 'collecting' | 'ready' | 'not_request'; mode?: TaskMode; request?: string; context?: string; launches: number; cancelled: boolean; perChunkLaunches: number[] }
interface TriggerCase { request?: string; lastTurn?: 'collecting' | 'ready' | 'not_request'; arrivalOffsetsMs?: number[]; finalWaitMs?: number; chunkSpeakers?: string[][]; chunkSpeakerIds?: number[][]; control?: 'send' | 'cancel'; mode?: TaskMode; source?: 'dictation'; prior?: string; recordingState?: RecordingState; name: string; chunks: string[][]; launch: boolean; cancel?: boolean }
const prior = 'We are discussing whether an approved application lets someone change jobs before the next stage is approved.';
const command = 'Replicas: could you go research that and come back to me with an answer?';
export const regressionCases: TriggerCase[] = [
  { name: 'fresh request after resumed recording retains ended marker', recordingState: 'previously-ended', chunks: [[command]], launch: true },
  { name: 'final request flushed after recording stop', recordingState: 'final-flush', chunks: [[command]], launch: true },
  { name: 'reported wording alone', chunks: [[command]], launch: true },
  { name: 'reported wording followed by casual conversation', chunks: [[command, 'So, that’d be really cool if that worked out.', 'I guess we’ll see what happens, though.', 'TBD?']], launch: true },
  { name: 'short contextual request', chunks: [['Replicas, go find out about that.']], launch: true },
  { name: 'explicit question', chunks: [['Replicas, check whether Electron supports macOS menu-bar icons.']], launch: true },
  { name: 'split unfinished request', chunks: [['Replicas, go find out whether'], ['Electron supports macOS menu-bar icons.']], launch: true },
  { name: 'quoted example', chunks: [['The example phrase is “Replicas, go research that.” I’m describing the feature, not asking for research.']], launch: false },
  { name: 'hypothetical request', chunks: [['If we asked Replicas to research that, would it take long? We aren’t asking it to do that now.']], launch: false },
  { name: 'negated request', chunks: [['Replicas, do not research this. I’m still deciding what I want to ask.']], launch: false },
  { name: 'request explicitly withdrawn', chunks: [[command, 'Actually, never mind. Don’t research that.']], launch: false },
  { name: 'explicit cancellation', chunks: [['Replicas, stop the research you already started.']], launch: false, cancel: true },
  { name: 'old request mentioned as history', chunks: [['Replicas already researched this yesterday. I’m just reading its answer now.']], launch: false },
];
export const additionalCases: TriggerCase[] = [
  { name: 'polite request with unrelated trailing remarks', chunks: [["Hey Replicas, would you check which operating systems Electron supports? Thanks. Anyway, let’s move to the next agenda item."]], launch: true },
  { name: 'new phrasing with contextual reference', chunks: [["Can you look into the job-change question for us, Replicas? We’ll keep chatting while you do that."]], launch: true },
  { name: 'third-party quote', chunks: [["Yesterday Alex said, ‘Replicas, go look that up.’ I’m just telling you what happened yesterday."]], launch: false },
  { name: 'product discussion', chunks: [["Replicas could research these questions, but right now we’re only discussing how to build this feature."]], launch: false },
];

export const delegationCases: TriggerCase[] = [
  { name: 'reported request after meandering speculative conversation', prior: "You: The camera on my laptop has this halo and I cannot figure out how to remove it.\nOther speaker: Where are you sitting?\nYou: In the other room while everyone gets ready. I moved here because it was noisy.\nOther speaker: The new coding workflow is promising, but I still need to set it up in our repository. The subscription is expensive though.\nYou: That is crazy. I found my phone. Anyway, someone got the first stage of their application approved yesterday. I think that means they can change jobs now and not risk losing approval, even though the next stage has not been approved yet. Right?", chunks: [['Can we have replicas go research this and come back with the answer?']], launch: true },
  { name: 'reported can-we-have request', chunks: [['Can we have replicas go research this and come back with the answer?']], launch: true },
  { name: 'tell someone to have Replicas research it', chunks: [['Go have Replicas research it.']], launch: true },
  { name: 'group delegation', chunks: [["Let’s get Replicas to check that and report back."]], launch: true },
  { name: 'softly worded present request', chunks: [["It’d be great if Replicas could look into that and get back to us."]], launch: true },
  { name: 'capability question about Replicas', chunks: [['Can Replicas do research or can it only write code?']], launch: false },
  { name: 'delegation deferred explicitly', chunks: [["We could have Replicas research this sometime, but we’re not doing that now."]], launch: false },
  { name: 'delegated request quoted as history', chunks: [['Alex asked if we could have Replicas research it yesterday. I am just recounting the conversation.']], launch: false },
];

export function dataset(cases: TriggerCase[]) {
  return cases.map(c => ({
    input: { name: c.name, prior: c.prior ?? prior, chunks: c.chunks, recordingState: c.recordingState, source: c.source, arrivalOffsetsMs: c.arrivalOffsetsMs, finalWaitMs: c.finalWaitMs, chunkSpeakers: c.chunkSpeakers, chunkSpeakerIds: c.chunkSpeakerIds, control: c.control },
    expected: { lastTurn: c.lastTurn, mode: c.mode ?? 'research', request: c.request ?? 'You: ' + c.chunks.flat().join(' '), context: c.source === 'dictation' ? '' : 'You: ' + (c.prior ?? prior), launches: c.launch ? 1 : 0, cancelled: !!c.cancel, perChunkLaunches: c.chunks.map((_, index) => c.launch && index === c.chunks.length - 1 ? 1 : 0) },
  }));
}

export const taskModeCases: TriggerCase[] = [
  { name: 'create Linear issue from dictation', source: 'dictation', chunks: [['Replicas, go create an issue in Linear to add the notification bell.']], launch: true, mode: 'implementation' },
  { name: 'implement mobile feedback drawer', source: 'dictation', chunks: [["Replicas, go add code so when I hit feedback it opens up a drawer on mobile. Keep the desktop behavior the same."]], launch: true, mode: 'implementation' },
  { name: 'contextual implementation after discussion', prior: 'On mobile, the feedback button should open a drawer. Keep the desktop popover unchanged.', chunks: [["Could we have Replicas go implement that please?"]], launch: true, mode: 'implementation' },
  { name: 'use a skill to create a task', source: 'dictation', chunks: [['Replicas, use the Linear skill to create a task for adding the notification bell.']], launch: true, mode: 'implementation' },
  { name: 'research implementation without changing code', source: 'dictation', chunks: [['Replicas, research how to add a feedback drawer on mobile. Do not change the code yet.']], launch: true },
  { name: 'review bug without fixing it', source: 'dictation', chunks: [['Replicas, find out why the feedback button is broken on mobile and report back.']], launch: true },
  { name: 'research then explicitly fix', source: 'dictation', chunks: [['Replicas, find out why the feedback button is broken on mobile and fix it.']], launch: true, mode: 'implementation' },
  { name: 'create issue about research', source: 'dictation', chunks: [['Replicas, create a Linear issue to research accessible mobile drawers. Do not implement the drawer.']], launch: true, mode: 'implementation' },
  { name: 'implementation withdrawn in same utterance', source: 'dictation', chunks: [['Replicas, add the notification bell. Actually, never mind, do not do that yet.']], launch: false },
  { name: 'quoted implementation example', source: 'dictation', chunks: [['An example command would be "Replicas, create a Linear issue." I am describing the feature, not requesting work.']], launch: false },
  { name: 'implementation capability question', source: 'dictation', chunks: [['Can Replicas write code or only research things?']], launch: false },
  { name: 'research instead of implementing', source: 'dictation', chunks: [['Replicas, add the notification bell. Actually, just research the options first, do not implement it.']], launch: true },
];

// Incident reconstruction: exact request, shortened surrounding conversation; real speech-end
// gaps were 12.12s and 10.20s. File arrival times are reconstructed, not captured telemetry.
const trialContext = 'We want a new user to start a 14-day Pro trial without entering a credit card, invite teammates during onboarding, and decide what happens when the trial ends. Free allows one user, so downgrading would require removing extra teammates. Today trials require entering a card through Stripe. We need to inspect the existing app and Stripe code and consider how other SaaS apps handle this product-led growth flow.';
const trialRequest = [
  'Replicas.',
  'Can you read the transcript and spawn off an agent that just researches this? Looks at our existing code and our Stripe code, and then comes up with a plan.',
  'No need to implement anything. I just want you to help do some research into how we should facilitate this, and think about how other SaaS apps have this type of product-led growth as well.',
];
export const streamingCases: TriggerCase[] = [
  { name: 'reported standalone wake followed by full trial research request', prior: trialContext, chunks: trialRequest.map(text => [text]), arrivalOffsetsMs: [0, 12120, 22320], finalWaitMs: 17000, launch: true },
  { name: 'request starts together but research-only scope arrives later', prior: trialContext, chunks: [[trialRequest[0] + ' ' + trialRequest[1]], [trialRequest[2]]], arrivalOffsetsMs: [0, 10200], finalWaitMs: 17000, launch: true },
  { name: 'continuous request longer than thirty seconds', prior: trialContext, chunks: [['Replicas.'], ['Can you research how'], ['our signup flow and Stripe code should support a no-card Pro trial,'], ['including team invites and what happens when the trial expires,'], ['and come back with a plan? Do not implement anything.']], arrivalOffsetsMs: [0, 10000, 20000, 30000, 40000], finalWaitMs: 17000, launch: true },
  { name: 'implementation corrected to research in a delayed scope clause', prior: trialContext, chunks: [['Replicas, change signup to start a Pro trial without asking for a card.'], ['Actually, do not change code yet. Just research our Stripe setup and come back with a plan.']], arrivalOffsetsMs: [0, 10000], finalWaitMs: 17000, launch: true },
  { name: 'request withdrawn in next transcript update', prior: trialContext, chunks: [['Replicas, implement the no-card Pro trial.'], ['Actually, never mind. Do not start that task.']], arrivalOffsetsMs: [0, 10000], finalWaitMs: 17000, launch: false },
  { name: 'bare wake alone cannot launch from context', prior: trialContext, chunks: [['Replicas.']], finalWaitMs: 17000, launch: false },
  { name: 'another speaker cannot inherit an unfinished wake', prior: trialContext, chunks: [['Replicas.'], ['Can you change the signup flow to start a Pro trial?']], chunkSpeakers: [['You'], ['Them']], arrivalOffsetsMs: [0, 10000], finalWaitMs: 17000, launch: false },
  { name: 'product mention does not carry into an unrelated request', prior: trialContext, chunks: [['The word Replicas is a wake name in this product. I am explaining how it works.'], ['Can you change the signup flow to start a Pro trial?']], arrivalOffsetsMs: [0, 10000], finalWaitMs: 17000, launch: false },
];


export const captureCases: TriggerCase[] = [
  { name: 'explicit finish hands off promptly', chunks: [["Replicas, research whether Electron supports macOS menu-bar icons. That's all."]], finalWaitMs: 5000, launch: true, lastTurn: 'ready' },
  { name: 'quoted finish cannot launch', chunks: [["An example is Replicas, research Electron. That's all. I am quoting the example, not asking for work."]], finalWaitMs: 5000, launch: false, lastTurn: 'not_request' },
  { name: 'unfinished scope is still collecting even after an actionable sentence', chunks: [['Replicas, research our Stripe trial setup. Before you start, I also want you to include']], finalWaitMs: 17000, launch: false, lastTurn: 'collecting' },
  { name: 'Send now bypasses settling but uses real Jev routing', chunks: [['Replicas, research whether Electron supports macOS menu-bar icons.']], control: 'send', finalWaitMs: 4000, launch: true, lastTurn: 'ready' },
  { name: 'Cancel stops an otherwise valid pending request', chunks: [['Replicas, implement the mobile feedback drawer.']], control: 'cancel', finalWaitMs: 17000, launch: false },
  { name: 'Jason name keeps fragments together across numeric speaker IDs', prior: trialContext, chunks: [['Replicas.'], ['Research how our Stripe code could support a no-card trial. Do not implement anything.']], chunkSpeakers: [['Jason Kovalenko'], ['Jason Kovalenko']], chunkSpeakerIds: [[1004], [1005]], arrivalOffsetsMs: [0, 10000], finalWaitMs: 17000, request: 'Jason Kovalenko: Replicas. Research how our Stripe code could support a no-card trial. Do not implement anything.', launch: true, lastTurn: 'ready' },
];
