import type {
  StructuredPdfExtractionRequest,
  StructuredPdfExtractionResult,
} from '../pdf-extraction';
import { defineGroup, invoke } from './contract';

export const pdfContract = defineGroup('pdf', {
  extractStructured: invoke<
    [request: StructuredPdfExtractionRequest],
    StructuredPdfExtractionResult
  >(),
});
