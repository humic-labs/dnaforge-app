import { molViewSpecStorySteps } from '../utils/molViewSpecStory';
import { MolecularViewNavigation } from './MolecularViewNavigation';

export function MolViewSpecStoryControls({
  scene,
  activeIndex,
  onSelect,
  comparison = false,
}: {
  scene: string;
  activeIndex: number;
  onSelect: (index: number) => void;
  comparison?: boolean;
}) {
  const steps = molViewSpecStorySteps(scene);
  if (steps.length < 2) return null;
  return (
    <div
      role="group"
      aria-label={comparison ? 'Scenes in comparison' : 'Views of selected structure'}
      title={
        comparison
          ? 'Each scene identifies the pinned structure it uses.'
          : "These views use this saved structure's coordinates."
      }
      className="contents"
    >
      <MolecularViewNavigation scene={scene} activeIndex={activeIndex} onSelect={onSelect} />
    </div>
  );
}
