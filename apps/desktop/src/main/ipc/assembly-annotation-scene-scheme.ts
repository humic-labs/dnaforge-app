import { ASSEMBLY_ANNOTATION_SCENE_RESOURCE_SCHEME } from '../../shared/indexed-genome';

interface ProtocolSchemeRegistrationApi {
  registerSchemesAsPrivileged(
    schemes: Array<{
      scheme: string;
      privileges: {
        standard: boolean;
        secure: boolean;
        supportFetchAPI: boolean;
        corsEnabled: boolean;
        stream: boolean;
      };
    }>
  ): void;
}

export function registerAssemblyAnnotationSceneScheme(
  protocolApi: ProtocolSchemeRegistrationApi
): void {
  protocolApi.registerSchemesAsPrivileged([
    {
      scheme: ASSEMBLY_ANNOTATION_SCENE_RESOURCE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}
