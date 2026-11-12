/**
 * MDX globals registry — components available inside MDX without `import`.
 * Wired via `<Content components={components} />` in `[...slug].astro`.
 * Add new components here as you build (or install) them.
 */

import { Aside } from "./components/ui/aside";
import Render from "./components/Render.astro";
import { Badge } from "./components/ui/badge";
import { Card } from "./components/ui/card";
import { CardGrid } from "./components/ui/card-grid";
import { CodeGroup } from "./components/ui/code-group";
import { FileTree } from "./components/ui/file-tree";
import { LinkButton } from "./components/ui/link-button";
import { LinkCard } from "./components/ui/link-card";
import { PackageManagers } from "./components/ui/package-managers";
import { Step, Steps } from "./components/ui/steps";
import { Tabs, TabItem } from "./components/ui/tabs";

export const components = {
  Aside,
  Badge,
  Card,
  CardGrid,
  CodeGroup,
  FileTree,
  LinkButton,
  LinkCard,
  PackageManagers,
  Render,
  Step,
  Steps,
  TabItem,
  Tabs,
};
