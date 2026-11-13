import { parseWorkspaceIdentity } from '@waypoint/domain-services';
import { defineBlob } from '@waypoint/workspace-revisions';
import {
  canonicalPayload,
  parseUniqueJson,
  scientificIdentityPath,
} from '@waypoint/scientific-objects';
import { resolveWorkspaceScope } from '../db/workspace-catalog';
import { platform } from '../platform';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import {
  classifyLimsEntityFieldIssues,
  type LimsEntity,
  type LimsUpdateEntityInput,
  type ScientificStrainEditAuthority,
} from '../shared/lims';
import { parseEntityArtifact } from '../shared/entity-artifact';
import { resolveEntityArtifactSchemaFields } from './entity-artifact-schema';
import { gitCommitPaths, gitStatus, isGitRepo } from '../features/workspace/public/git';
import {
  publishNativeArtifact,
  NativeArtifactPublicationPendingError,
} from './publish-native-artifact';
import { withRendererWorkspaceMutation } from './workspace-mutation-transaction';
import { scientificRelationshipGitPaths } from './scientific-git-projections';

const equal = (left: unknown, right: unknown): boolean =>
  left === undefined || right === undefined
    ? left === right
    : canonicalPayload(left) === canonicalPayload(right);

export async function updateAcceptedStrain(
  supplied: LimsUpdateEntityInput,
  suppliedAuthority: ScientificStrainEditAuthority,
  suppliedToken?: string
): Promise<LimsEntity> {
  const input = structuredClone(supplied);
  const authority = structuredClone(suppliedAuthority);
  if (authority.revision.resourceId !== input.id)
    throw new Error('The strain draft does not match its captured accepted identity.');
  if (input.workspaceId !== undefined && input.workspaceId !== authority.workspaceId)
    throw new Error('A strain field edit must remain in its captured project.');
  if (
    input.replaceFields ||
    (input.relationshipTargets && Object.keys(input.relationshipTargets).length)
  )
    throw new Error(
      'Strain field replacement or relationship changes require an explicit scientific operation.'
    );
  const relativePath = pathRelativeToBoundary(authority.artifactPath, authority.workspaceRoot);
  if (!relativePath) throw new Error('The strain draft has no captured project path.');
  const scope = await resolveWorkspaceScope(authority.workspaceRoot);
  if (!scope) throw new Error('The strain project is unavailable.');
  return withRendererWorkspaceMutation(
    authority.workspaceRoot,
    async (mutationToken) => {
      const snapshot = await platform().scientificObjects.read({
        workspaceRoot: authority.workspaceRoot,
        request: {
          workspace: parseWorkspaceIdentity(scope),
          resourceId: input.id,
          revisionId: authority.revision.resourceRevisionId,
        },
      });
      const representation = snapshot?.representation;
      if (
        !snapshot ||
        snapshot.resourceId !== input.id ||
        snapshot.revisionId !== authority.revision.resourceRevisionId ||
        snapshot.document.kind !== 'strain' ||
        representation?.format !== 'strain-entity-v1' ||
        defineBlob(new TextEncoder().encode(representation.text)).hash !==
          `sha256:${authority.revision.contentSha256}`
      )
        throw new Error(
          'The captured strain revision is unavailable or inconsistent. Reopen it before saving.'
        );
      const original = parseEntityArtifact(representation.text);
      if (original.id !== input.id || original.kind !== 'strain')
        throw new Error('The captured native strain identity is inconsistent.');
      const raw = parseUniqueJson(representation.text);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('The captured strain data is malformed.');
      const name = input.name === undefined ? original.name : input.name.trim();
      if (!name) throw new Error('Strain name is required.');
      const fields = { ...original.fields, ...input.fields };
      for (const key of ['artifact', 'sourceMetadata'])
        if (!equal(fields[key], original.fields[key]))
          throw new Error('Strain provenance and file identity require their own operation.');
      const definitions = await resolveEntityArtifactSchemaFields('strain');
      const issues = classifyLimsEntityFieldIssues('strain', fields, definitions);
      if (issues.malformed.length || issues.incomplete.length)
        throw new Error([...issues.malformed, ...issues.incomplete].join('; '));
      const next = {
        ...raw,
        name,
        fields,
        registrationStatus: input.registrationStatus ?? original.registrationStatus,
        domainStatus: input.domainStatus !== undefined ? input.domainStatus : original.domainStatus,
      };
      const content = equal(raw, next) ? representation.text : `${JSON.stringify(next, null, 2)}\n`;
      parseEntityArtifact(content);
      const isGit = await isGitRepo(authority.workspaceRoot, mutationToken);
      const dirtyBefore = isGit
        ? await gitStatus(authority.workspaceRoot, mutationToken)
        : new Map<string, unknown>();
      const accepted = await publishNativeArtifact({
        workspaceRoot: authority.workspaceRoot,
        artifactPath: authority.artifactPath,
        resourceId: input.id,
        prior: authority.revision,
        representation: { format: 'strain-entity-v1', text: content },
        mutationToken,
      });
      try {
        const projected = (await platform().lims.queryEntities({ id: input.id, limit: 1 }))[0];
        if (
          !projected ||
          projected.kind !== 'strain' ||
          projected.workspaceId !== authority.workspaceId ||
          projected.name !== next.name ||
          !equal(projected.fields, next.fields) ||
          projected.registrationStatus !== next.registrationStatus ||
          projected.domainStatus !== next.domainStatus
        )
          throw new Error('Strain Registry refresh remains incomplete.');
        if (isGit) {
          const dirtyAfter = await gitStatus(authority.workspaceRoot, mutationToken);
          const paths = [
            relativePath,
            scientificIdentityPath,
            ...(await scientificRelationshipGitPaths(authority.workspaceRoot, dirtyAfter)),
            ...[...dirtyAfter.keys()].filter(
              (path) => path.startsWith('.waypoint/lims/') && !dirtyBefore.has(path)
            ),
          ].filter((path) => dirtyAfter.has(path));
          if (paths.length)
            await gitCommitPaths(
              authority.workspaceRoot,
              `Update strain ${name}`,
              paths,
              mutationToken
            );
        }
        return projected;
      } catch (error) {
        throw new NativeArtifactPublicationPendingError(
          accepted,
          error instanceof Error ? error.message : 'strain publication remains incomplete.'
        );
      }
    },
    suppliedToken
  );
}
