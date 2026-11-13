export { nativeFileDocumentOutputSchema as fileDocumentOutputSchema } from './native-document-output-schemas';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {useWorkspaceStore,type WorkspaceFolder} from '../../../stores/workspaceStore';
import {isFileDocumentDirtyListRequest} from '../../../shared/file-document';
import {pageNativeDirtyDocuments} from '../../../shared/native-document-drafts';
import {normalizePathForBoundary} from '../../../shared/path-boundary';
import { useCanvasStore } from '../../canvas/public/store';
import { platform } from '../../../platform';
import { fileDocumentToolRequestSchema, type FileDocumentTarget } from '../../../shared/file-document';
import { resolveWorkspaceEntry } from './workspace-entry';
import { flushFileDocumentClients } from '../../workspace/public/file-document-client';

export const fileDocumentSchema = fileDocumentToolRequestSchema;

export const FILE_DOCUMENT_DESCRIPTION =
 'List unsaved native drafts and retained recovery with operation:list-dirty, optional exact project, bounded limit and nextCursor. Listing needs no target or open tab and returns stable IDs, revisions, kinds and recovery states. Inspect each returned target before saving or explicitly discarding; Save All never restores an unaccepted recovery. Inspect native file-backed working copies and use their declared typed edit, undo, save and recovery commands. Text/code, CSV/TSV, sequence and notebook adapters share the same owner with human views. Other scientific formats declare their supported owner and capabilities. Use target.path for an exact project-qualified or admitted absolute path, or target.documentId returned by inspect. The legacy tabId locator remains accepted for an ordinary text/table view. Inspect first and pass expectedRevision on changes. For text edits prefer operation:replace-string with oldText copied exactly from inspect.text and newText. The native owner finds the position; exactly one match is required, otherwise no edit is applied. Use inspect again for a missing match or include surrounding text for multiple matches. Use save afterward to publish the edited revision. Text offsets are zero-based UTF-16 positions in inspected LF-normalized text. Table indices are zero-based source body rows and columns; headers are column labels. CSV/TSV store values without rich formatting. Scientific operations preserve their own schemas and coordinates. Save publishes its captured revision and retains later edits. External disk changes refuse overwrite. Binary, sliced and readonly previews are not editable as ordinary text.';

export function createFileDocumentTool(folders:readonly WorkspaceFolder[]) {
 return resultTool({description:FILE_DOCUMENT_DESCRIPTION,inputSchema:fileDocumentSchema,
 execute:async(input,{abortSignal})=>{
  let attempted=false;
  try {
   if(isFileDocumentDirtyListRequest(input)) {
    abortSignal?.throwIfAborted();
    const granted=new Set(folders.map(folder=>normalizePathForBoundary(folder.path)));
    const projects=useWorkspaceStore.getState().folders.filter(folder=>granted.has(normalizePathForBoundary(folder.path)));
    const page=await pageNativeDirtyDocuments(input,{projects,documents:await platform().fs.listDirtyDocuments()});
    return toolSuccess({...page});
   }
   const {target,tabId,expectedRevision,operation,requestId}=input;
   let resolved:FileDocumentTarget;
   const mutating=operation.kind!=='inspect' && !(operation.kind==='table' && operation.command.kind==='inspect') && !(operation.kind==='sequence' && operation.command.kind==='inspect');
   if(target && 'documentId' in target) resolved=target;
   else {
    const tab=tabId?Object.values(useCanvasStore.getState().panels).flatMap((panel)=>panel.tabs).find((candidate)=>candidate.id===tabId):undefined;
    if(tabId && (!tab || tab.type!=='text' && !(tab.type==='table' || tab.type==='file') || tab?.type!=='text' && !/\.(csv|tsv)$/i.test(tab?.sourceFileName??tab?.entityId??'')))throw new Error('FILE_DOCUMENT_LEGACY_TARGET_UNSUPPORTED: Use the scientific document native identity and commands.');
    if(tab?.readOnly&&mutating)throw new Error('READ_ONLY_FILE: This view is read-only.');
    const path=target && 'path' in target?target.path:tab?.entityId;
    if(!path)throw new Error('FILE_DOCUMENT_NOT_FOUND: Inspect an exact workspace path.');
    const entry=resolveWorkspaceEntry(folders,path,mutating);
    resolved={path:entry.absolutePath,workspaceRoot:entry.folder.path};
   }
   abortSignal?.throwIfAborted();
   await flushFileDocumentClients();
   attempted=mutating;
   const snapshot=await platform().fs.fileDocument({target:resolved,expectedRevision,operation,requestId:requestId??crypto.randomUUID(),ordinaryOnly:Boolean(tabId)});
   resolveWorkspaceEntry(folders,snapshot.path,mutating);
   const {content,persistedContent,diskContent,tableData,headerRowValues,firstRowAsHeader,...inspection}=snapshot;
   return toolSuccess({...inspection,...(mutating?{applied:true}:{}),...(operation.kind==='save'?{saved:true}:{})});
  }catch(error){
   const message=error instanceof Error?error.message:String(error);
   const code=/^([A-Z][A-Z0-9_]+):/.exec(message)?.[1]??'FILE_DOCUMENT_FAILED';
   if(['FILE_CHANGED','STALE_FILE_DRAFT','READ_ONLY_FILE','OUTSIDE_WORKSPACE','FILE_DOCUMENT_NOT_FOUND','TEXT_NOT_FOUND','TEXT_MATCH_AMBIGUOUS'].includes(code))attempted=false;
   return toolFailure({code,error:message,retriable:false,stateChanged:attempted?'unknown':false,partialEffects:[]});
  }
 }
 });
}
