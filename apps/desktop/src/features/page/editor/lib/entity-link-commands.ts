import { filterCommands, type SlashCommand } from './commands';
import {
  getEntityCategoryIcon,
  matchingEntityLinkCategories,
  type EntityLinkCategory,
} from './search';

const linkEntity: SlashCommand = {
  name: 'entity-link',
  label: 'Link an entity',
  description: 'Link an existing entity',
  icon: '@',
  keywords: ['link', 'reference', 'entity'],
  category: 'entity',
  entityCategory: null,
};

export function entityLinkSlashCommands(
  categories: readonly EntityLinkCategory[],
  query = ''
): SlashCommand[] {
  const matches = query.trim()
    ? matchingEntityLinkCategories(categories, query)
    : categories.filter((category) => category.browse !== false);
  return [
    ...filterCommands([linkEntity], query),
    ...matches.map(
      (category): SlashCommand => ({
        name: `entity-link:${category.key}`,
        label: category.browse === false ? `Link ${category.label.toLowerCase()}` : category.label,
        description: 'Link an existing entity',
        icon: getEntityCategoryIcon(category),
        keywords: [...category.terms],
        category: 'entity',
        entityCategory: category,
      })
    ),
  ];
}
