import { inputTargetAllows, subscribeInputRevocation } from '@waypoint/platform/input-ownership';
import type { InputObserver } from 'molstar/lib/mol-util/input/input-observer';

export function installMolstarInputOwnership(input: InputObserver, canvas: HTMLElement): void {
  input.setInputPolicy(
    (kind, event) => canvas.isConnected && inputTargetAllows(canvas, kind, event)
  );
  const disposePointer = subscribeInputRevocation(canvas, () => input.cancelInput('pointer'));
  const disposeKeyboard = subscribeInputRevocation(
    canvas,
    () => input.cancelInput('keyboard'),
    'keyboard'
  );
  const dispose = input.dispose;
  input.dispose = () => {
    disposePointer();
    disposeKeyboard();
    input.setInputPolicy(() => false);
    input.cancelInput();
    dispose();
  };
}
