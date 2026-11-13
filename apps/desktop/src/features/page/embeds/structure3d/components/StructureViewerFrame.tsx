import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { SequenceViewer, type SequenceViewerProps } from './SequenceViewer';

type StructureViewerFrameProps = ComponentPropsWithoutRef<'div'> & {
  sequence: SequenceViewerProps;
  sequenceKey?: string;
  header?: ReactNode;
};

export const StructureViewerFrame = forwardRef<HTMLDivElement, StructureViewerFrameProps>(
  function StructureViewerFrame({ sequence, sequenceKey, header, children, ...props }, ref) {
    return (
      <div {...props} ref={ref}>
        {header}
        <SequenceViewer key={sequenceKey} {...sequence} />
        {children}
      </div>
    );
  }
);
