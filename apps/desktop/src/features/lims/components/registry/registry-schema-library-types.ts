import type {
  LimsDefineSchemaInput,
  LimsRefineSchemaInput,
  LimsSchemaDefinitionView,
} from '../../../../shared/lims';

export interface RegistrySchemaSource {
  id: string;
  label: string;
  schemas: LimsSchemaDefinitionView[];
  readOnly?: boolean;
  onDefine: (input: LimsDefineSchemaInput) => Promise<unknown>;
  onRefine: (input: LimsRefineSchemaInput) => Promise<unknown>;
  onChanged: () => Promise<void> | void;
}
