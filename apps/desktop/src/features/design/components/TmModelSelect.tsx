import { DownwardSelect } from '../../../shared/components/DownwardSelect';
import { MetadataPicker } from '../../../shared/components/entity-metadata/MetadataPicker';
import {
  LOCAL_SELECT_VALUE,
  NEB_TM_OPTIONS,
  OWCZARZY_SELECT_VALUE,
  tmModelFromSelectValue,
  tmModelLabel,
  tmModelSelectValue,
  type TmModel,
} from '../algorithms/tm-model';

const TM_OPTIONS = [
  { value: LOCAL_SELECT_VALUE, label: 'Default (SantaLucia)' },
  { value: OWCZARZY_SELECT_VALUE, label: 'SantaLucia + Owczarzy salt (custom)' },
  ...NEB_TM_OPTIONS.map((opt) => ({ value: opt.prodcode, label: opt.label })),
] as const;

export interface TmModelSelectProps {
  value: TmModel;
  onChange: (model: TmModel) => void;
  testId?: string;
  className?: string;
  settingsAppearance?: boolean;
}

export function TmModelSelect({
  value,
  onChange,
  testId = 'tm-model-select',
  className,
  settingsAppearance = false,
}: TmModelSelectProps) {
  const selectValue = tmModelSelectValue(value);
  const options = TM_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    testId: `${testId}-option-${option.value}`,
  }));
  if (settingsAppearance) {
    return (
      <MetadataPicker
        value={selectValue}
        options={options}
        onValueChange={(next) => onChange(tmModelFromSelectValue(next))}
        ariaLabel="Tm model"
        testId={testId}
        privateContent
      />
    );
  }
  return (
    <DownwardSelect
      testId={testId}
      privateContent
      ariaLabel="Tm model"
      title="Tm calculation model"
      value={selectValue}
      label={tmModelLabel(value)}
      className={className}
      options={options}
      onChange={(next) => onChange(tmModelFromSelectValue(next))}
    />
  );
}
