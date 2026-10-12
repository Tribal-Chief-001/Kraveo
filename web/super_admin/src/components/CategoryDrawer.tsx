import React from 'react';
import { Tags } from 'lucide-react';
import { Category } from '../lib/categoryParse';
import { CategoryForm } from './CategoryForm';
import { Drawer } from './ui/Drawer';

interface Props {
  /** null = add a category. */
  category: Category | null;
  onClose: () => void;
  onSaved: (category: Category, created: boolean, message: string) => void;
  onAuthError: (error: unknown) => void;
}

export const CategoryDrawer: React.FC<Props> = ({ category, onClose, onSaved, onAuthError }) => (
  <Drawer open onClose={onClose} title={category ? `Edit “${category.name}”` : 'Add a category'} subtitle={category ? 'Name, icon and where it is used' : 'Available to restaurants, dishes or both'} icon={Tags} wide>
    <CategoryForm category={category} mode="full" onSaved={onSaved} onCancel={onClose} onAuthError={onAuthError} />
  </Drawer>
);
