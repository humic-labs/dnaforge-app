# Embed System

The embed system allows embedding rich content (sequences, primers, 3D
structures, images, tables) in page documents via a plugin architecture.

## Architecture Overview

```
embeds/
├── index.ts           # Imports all embed packages to trigger registration
├── registry.ts        # EmbedRegistry singleton (SINGLE SOURCE OF TRUTH)
├── types.ts           # Shared TypeScript interfaces
├── sequence/          # Sequence embed package
│   ├── definition.ts  # Registers with embedRegistry
│   ├── Renderer.tsx   # Display component
│   ├── Picker.tsx     # Selection UI
│   └── index.ts       # Package exports
├── primer/            # Primer embed package
├── structure3d/       # 3D structure embed package
├── image/             # Image embed package
└── table/             # Table embed package
```

**Key components:**

- **EmbedRegistry** (`registry.ts`): Singleton that stores all embed
  definitions. Provides renderers, pickers, and slash commands.
- **EmbedNode** (`../editor/extensions/embed-node.ts`): Generic TipTap node that
  delegates rendering to registered embed types.
- **FlowManager** (`../editor/flows/`): Orchestrates multi-step picker flows for
  embed insertion.

## Adding a New Embed Type

### 1. Create the package directory

```
mkdir -p embeds/myembed
```

### 2. Create the Renderer component

`embeds/myembed/Renderer.tsx`:

```tsx
import { EmbedWrapper, EmbedPlaceholder } from '../shared';
import type { EmbedRendererProps } from '../types';

interface MyEmbedData {
  name: string;
  // ... other fields
}

export function MyEmbedRenderer({
  attrs,
  selected,
  onRemove,
}: EmbedRendererProps) {
  const data = attrs as MyEmbedData;

  // Handle missing data
  if (!data.name) {
    return <EmbedPlaceholder type="myembed" message="No data" />;
  }

  return (
    <EmbedWrapper selected={selected} onRemove={onRemove}>
      <div className="p-3">
        {/* Your embed content */}
        <span>{data.name}</span>
      </div>
    </EmbedWrapper>
  );
}
```

### 3. Create the Picker component (optional)

If your embed can be inserted via slash commands, create a picker:

`embeds/myembed/Picker.tsx`:

```tsx
import type { PickerStageProps } from '../types';

interface Item {
  id: string;
  name: string;
}

export function MyEmbedPicker({ onAdvance, onCancel }: PickerStageProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);

  // Fetch items from your data source
  useEffect(() => {
    // TODO: Replace with real data fetching
    setItems([
      { id: '1', name: 'Item 1' },
      { id: '2', name: 'Item 2' },
    ]);
  }, []);

  const handleSelect = (item: Item) => {
    setSelected(item);
  };

  const handleConfirm = () => {
    if (selected) {
      onAdvance({
        itemId: selected.id,
        itemName: selected.name,
      });
    }
  };

  return (
    <div className="p-3">
      {/* Selection UI */}
      <ul>
        {items.map((item) => (
          <li
            key={item.id}
            onClick={() => handleSelect(item)}
            className={selected?.id === item.id ? 'bg-accent' : ''}
          >
            {item.name}
          </li>
        ))}
      </ul>

      {/* Actions */}
      <div className="flex justify-end gap-2 mt-3">
        <button onClick={onCancel}>Cancel</button>
        <button onClick={handleConfirm} disabled={!selected}>
          Insert
        </button>
      </div>
    </div>
  );
}
```

### 4. Create the definition file

`embeds/myembed/definition.ts`:

```tsx
import { embedRegistry } from '../registry';
import { MyEmbedPicker } from './Picker';
import { MyEmbedRenderer } from './Renderer';
import type { EmbedDefinition } from '../types';

export const myEmbed: EmbedDefinition = {
  type: 'myembed', // Unique identifier
  label: 'My Embed', // Display name in slash menu
  icon: '📦', // Emoji or icon
  keywords: ['my', 'embed'], // Search keywords

  Renderer: MyEmbedRenderer,

  picker: {
    stages: [
      {
        name: 'Select Item',
        component: MyEmbedPicker,
      },
    ],
    size: 'md', // 'sm' | 'md' | 'lg' | 'xl'
    onComplete: (data) => ({
      refId: data.itemId as string,
      data: {
        name: data.itemName as string,
      },
    }),
  },
};

// Auto-register when this module is imported
embedRegistry.register(myEmbed);
```

### 5. Create the index file

`embeds/myembed/index.ts`:

```tsx
export { MyEmbedRenderer } from './Renderer';
export { MyEmbedPicker } from './Picker';
export { myEmbed } from './definition';
```

### 6. Register by importing

Add import to `embeds/index.ts`:

```tsx
import './myembed';
```

That's it! Your embed will now:

- Appear in the slash command menu under "Embeds"
- Have a picker flow for insertion
- Render properly in documents

## Multi-Stage Pickers

For complex embeds that need multiple selection steps:

```tsx
picker: {
  stages: [
    { name: 'Step 1', component: Step1Picker },
    { name: 'Step 2', component: Step2Picker },
    { name: 'Step 3', component: Step3Picker },
  ],
  size: 'lg',
  onComplete: (data) => ({
    refId: data.finalId as string,
    data: {
      step1Result: data.step1Value,
      step2Result: data.step2Value,
      step3Result: data.step3Value,
    },
  }),
}
```

Each stage receives accumulated data from previous stages in `props.data`.

## Shared Components

Use these from `embeds/shared/`:

- **EmbedWrapper**: Provides consistent selection chrome (border, delete button)
- **EmbedPlaceholder**: Loading/error states with consistent styling

## Type Definitions

See `types.ts` for full interface definitions:

- `EmbedDefinition`: Complete embed type definition
- `EmbedRendererProps`: Props passed to Renderer components
- `PickerStageProps`: Props passed to Picker stage components
- `PickerSize`: Popup size options ('sm' | 'md' | 'lg' | 'xl')

## Testing

Run the dev server and test:

1. Open a page
2. Type `/` to open slash menu
3. Search for your embed type
4. Complete the picker flow
5. Verify the embed renders correctly
