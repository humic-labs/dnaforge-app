import manifestData from './manifest.json';

export interface CodexAppServerTarget {
  verified: true;
  triple: string;
  aliasPackageName: string;
  npmPackageVersion: string;
  npmPackageTarball: string;
  npmPackageIntegrity: string;
  npmPackageShasum: string;
  codexBinaryPathInPackage: string;
  codexBinarySha256: string;
  codexPackageJsonPathInPackage: string;
  codexPackageJsonSha256: string;
  resources: Array<{
    pathInPackage: string;
    sha256: string;
    executable: boolean;
  }>;
}

export interface CodexAppServerManifest {
  schemaVersion: string;
  codexAppServerVersion: string;
  upstream: {
    tag: string;
    commit: string;
    repository: string;
  };
  generation: {
    command: string;
    schemaDigestAlgorithm: 'sha256-length-framed-relative-path-and-content-v1';
    schemaDigestSha256: string;
    generatedAt: string;
    generatorVersion: string;
  };
  sourcePackage: {
    name: string;
    version: string;
    tarball: string;
    integrity: string;
    shasum: string;
  };
  binaryVersionOutput: string;
  license: {
    spdx: 'Apache-2.0';
    files: Array<{ path: string; sha256: string }>;
  };
  supportedTargets: Record<string, CodexAppServerTarget>;
  upstreamProtocolMethods: {
    client: string[];
    server: string[];
    notification: string[];
  };
}

export const manifest: CodexAppServerManifest = manifestData as CodexAppServerManifest;
