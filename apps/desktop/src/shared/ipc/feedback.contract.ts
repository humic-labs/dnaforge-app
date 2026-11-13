import type { FeedbackPayload, FeedbackResult } from '../feedback';
import { defineGroup, invoke, type ClientOf } from './contract';

export const feedbackContract = defineGroup('feedback', {
  send: invoke<[payload: FeedbackPayload], FeedbackResult>(),
  cancel: invoke<[id: string], FeedbackResult>(),
});

export type FeedbackPort = ClientOf<typeof feedbackContract>;
