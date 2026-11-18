import { defineGroup, event, invoke } from './contract';
import type {
  NativeProtocolCreateRequest,
  NativeProtocolStartRunRequest,
  NativeProtocolCreationInspectRequest,
  NativeProtocolPackageReadRequest,
  NativeProtocolPackageListRequest,
  NativeProtocolPackageSaveRequest,
  NativeProtocolEditDeclarationsRequest,
  NativeProtocolRecordRunValuesRequest,
  NativeProtocolCreationResult,
  NativeProtocolPackageSnapshot,
  NativeProtocolPackageChanged,
} from '../protocol-packages';
export const protocolsContract = defineGroup('protocols', {
  onChanged: event<[change: NativeProtocolPackageChanged]>().channel('protocols:changed'),
  createProtocol: invoke<[request: NativeProtocolCreateRequest], NativeProtocolCreationResult>(),
  startRun: invoke<[request: NativeProtocolStartRunRequest], NativeProtocolCreationResult>(),
  inspectCreation: invoke<
    [request: NativeProtocolCreationInspectRequest],
    NativeProtocolCreationResult
  >(),
  recoverCreation: invoke<
    [request: NativeProtocolCreationInspectRequest],
    NativeProtocolCreationResult
  >(),
  readPackage: invoke<[request: NativeProtocolPackageReadRequest], NativeProtocolPackageSnapshot>(),
  readSavedProtocol: invoke<
    [request: NativeProtocolPackageReadRequest],
    NativeProtocolPackageSnapshot
  >(),
  listPackages: invoke<
    [request: NativeProtocolPackageListRequest],
    readonly NativeProtocolPackageSnapshot[]
  >(),
  savePackage: invoke<[request: NativeProtocolPackageSaveRequest], NativeProtocolCreationResult>(),
  editProtocolDeclarations: invoke<
    [request: NativeProtocolEditDeclarationsRequest],
    NativeProtocolCreationResult
  >(),
  recordRunValues: invoke<
    [request: NativeProtocolRecordRunValuesRequest],
    NativeProtocolCreationResult
  >(),
});
