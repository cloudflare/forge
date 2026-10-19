/**
 * MDX globals registry — components available inside MDX without `import`.
 * Wired via `<Content components={components} />` in `[...slug].astro`, and
 * parsed at build time by the MDX validator, which fails the build on a
 * PascalCase tag that is neither registered here nor imported by the page.
 */

import { Aside } from './components/ui/aside';
import { Badge } from './components/ui/badge';
import { Card } from './components/ui/card';
import { CardGrid } from './components/ui/card-grid';
import { LinkCard } from './components/ui/link-card';
import { PackageManagers } from './components/ui/package-managers';
import Render from './components/Render.astro';
import { Step, Steps } from './components/ui/steps';
import { Tabs, TabItem } from './components/ui/tabs';

// Ours, not Nimbus's.
import Features from './components/Features.astro';
import Hero from './components/Hero.astro';
import NavList from './components/NavList.astro';
import PipelineFigure from './components/PipelineFigure.astro';
import Prose from './components/Prose.astro';

export const components = {
  Aside,
  Badge,
  Card,
  CardGrid,
  Features,
  Hero,
  LinkCard,
  NavList,
  PackageManagers,
  PipelineFigure,
  Prose,
  Render,
  Step,
  Steps,
  TabItem,
  Tabs,
};
