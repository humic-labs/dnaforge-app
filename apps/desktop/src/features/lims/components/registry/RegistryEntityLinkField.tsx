import {
  EntityLinkField,
  type EntityLinkFieldProps,
} from '../../../../components/entity-reference/EntityLinkField';
import { queryLimsRegistrySummaries } from '../../operations';

async function searchTargets(search: string, offset: number) {
  const page = await queryLimsRegistrySummaries({ search, limit: 20, offset });
  return {
    choices: page.summaries.filter((summary) => !summary.archived),
    totalCount: page.totalCount,
  };
}

async function openTarget(entityId: string) {
  const { isLimsEntityOpened, openLimsEntity } = await import('../../open-entity');
  const result = await openLimsEntity({ entityId });
  if (!isLimsEntityOpened(result)) throw new Error(result.message);
}

export function RegistryEntityLinkField(
  props: Omit<EntityLinkFieldProps, 'searchTargets' | 'onOpen'>
) {
  return <EntityLinkField {...props} searchTargets={searchTargets} onOpen={openTarget} />;
}
