import type { EntityColorFamily } from '../../shared/entity-color-family';

export interface IconProps {
  colorFamily?: EntityColorFamily;
  size?: number;
  className?: string;
}

export interface PinIconProps extends IconProps {
  filled?: boolean;
}

export interface PlannotateIconProps extends IconProps {
  hovered?: boolean;
}

export interface AnnotationsIconProps extends IconProps {
  hovered?: boolean;
}

export interface AlignmentIconProps extends IconProps {
  hovered?: boolean;
}

export interface ComplementIconProps extends IconProps {
  hovered?: boolean;
  active?: boolean;
}

export interface TranslationIconProps extends IconProps {
  hovered?: boolean;
}

export interface PrimerIconProps extends IconProps {
  hovered?: boolean;
  active?: boolean;
}

export interface CutSitesIconProps extends IconProps {
  hovered?: boolean;
  active?: boolean;
}

export interface SmartTranslationIconProps extends IconProps {
  hovered?: boolean;
}

export interface REToolIconProps extends IconProps {
  hovered?: boolean;
}
