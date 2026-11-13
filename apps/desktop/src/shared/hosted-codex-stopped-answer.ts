export const STOPPED_ASSISTANT_NOTICE = '*[Stopped. Send a follow-up to resume.]*';

export function hostedCodexStoppedAnswer(answer: string): string {
  return answer.length === 0
    ? STOPPED_ASSISTANT_NOTICE
    : `${answer}\n\n${STOPPED_ASSISTANT_NOTICE}`;
}
