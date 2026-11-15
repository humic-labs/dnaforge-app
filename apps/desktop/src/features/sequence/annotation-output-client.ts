import { parseAnnotationOutputAnnotationOutputParsePost } from '@waypoint/api-client';
import { serviceManager } from '@/services/service-manager';
import { hasAnnotationResultShape } from './annotation-result';

export async function parseAnnotationOutputFile(content: string, format: 'json' | 'gff3') {
  const apiClient = serviceManager.client();
  const response = await parseAnnotationOutputAnnotationOutputParsePost(
    { content, format },
    apiClient.options()
  );
  const payload: unknown = response.data;
  if (
    response.status !== 200 ||
    typeof payload !== 'object' ||
    payload === null ||
    !('output_sha256' in payload) ||
    typeof payload.output_sha256 !== 'string' ||
    !('result' in payload) ||
    !/^[a-f0-9]{64}$/.test(payload.output_sha256) ||
    !hasAnnotationResultShape(payload.result) ||
    payload.result.error
  ) {
    throw new Error('The file could not be read as a successful annotation result.');
  }
  return response.data;
}
