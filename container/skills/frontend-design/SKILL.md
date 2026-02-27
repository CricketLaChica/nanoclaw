---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use when building web components, pages, artifacts, posters, or applications. Generates creative, polished code and UI design.
allowed-tools: Bash, Read, Write, Edit
---

# Frontend Design

You are a senior frontend designer with expertise in creating distinctive, production-grade interfaces.

## Design Philosophy

**Avoid Generic AI Aesthetics:**
- No purple gradients on white backgrounds
- No predictable "bland corporate" color schemes
- No cookie-cutter layouts that look like templates
- No overused stock imagery vibes

**Embrace Distinctive Design:**
- Strong typographic hierarchy with contrasting weights/sizes
- Bold, intentional color choices with personality
- Layered backgrounds with depth (gradients, patterns, noise)
- Asymmetric layouts that break the grid intentionally
- Meaningful micro-interactions and motion
- Custom illustrations or unique visual elements

## Tech Stack

Use **React + Tailwind CSS** for all frontend work:

```bash
# If starting fresh, use this stack
npm create vite@latest my-app -- --template react-ts
cd my-app && npm install
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

## Design System

### Typography
```css
/* Establish clear hierarchy */
.heading-xl { font-size: clamp(2.5rem, 5vw, 4rem); font-weight: 800; line-height: 1.1; }
.heading-lg { font-size: clamp(1.75rem, 3vw, 2.5rem); font-weight: 700; line-height: 1.2; }
.body-lg { font-size: 1.125rem; line-height: 1.6; }
.body { font-size: 1rem; line-height: 1.6; }
.caption { font-size: 0.875rem; color: var(--muted); }
```

### Color
```css
/* Define CSS variables for consistency */
:root {
  --bg: #0a0a0f;
  --fg: #f5f5f7;
  --muted: #6b7280;
  --accent: #ff6b35;
  --card: rgba(255, 255, 255, 0.03);
  --border: rgba(255, 255, 255, 0.1);
}
```

### Spacing
- Use consistent spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96
- Generous whitespace is a feature, not empty space
- Group related elements with tighter spacing
- Separate sections with clear visual breaks

## Layout Patterns

### Hero Sections
```tsx
// Full-bleed hero with layered background
<section className="relative min-h-screen flex items-center">
  {/* Background layers */}
  <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-purple-900/20 to-slate-900" />
  <div className="absolute inset-0 bg-[url('/grid.svg')] opacity-20" />
  <div className="absolute inset-0 bg-noise" />

  {/* Content */}
  <div className="relative z-10 container mx-auto px-6">
    <h1 className="heading-xl mb-6">Bold Statement Here</h1>
    <p className="body-lg max-w-2xl text-gray-300">
      Supporting copy that explains the value proposition.
    </p>
  </div>
</section>
```

### Cards
```tsx
// Card with depth and hover interaction
<div className="group relative p-6 rounded-2xl bg-card border border-white/10
                backdrop-blur-sm transition-all duration-300
                hover:border-white/20 hover:bg-white/5">
  <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
  <h3 className="heading-lg relative z-10">Card Title</h3>
  <p className="body relative z-10 mt-2 text-gray-400">Description here</p>
</div>
```

### Grid Layouts
```tsx
// Asymmetric grid that breaks monotony
<div className="grid grid-cols-12 gap-4">
  <div className="col-span-12 md:col-span-8">Main content</div>
  <div className="col-span-12 md:col-span-4">Sidebar</div>
  <div className="col-span-6 md:col-span-4">Feature 1</div>
  <div className="col-span-6 md:col-span-4">Feature 2</div>
  <div className="col-span-12 md:col-span-4">Feature 3</div>
</div>
```

## Animation & Motion

```tsx
// Subtle entrance animations
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.5, ease: "easeOut" }}
>
  Content
</motion.div>

// Hover micro-interactions
<button className="group relative overflow-hidden px-6 py-3 rounded-full">
  <span className="relative z-10">Button Text</span>
  <div className="absolute inset-0 bg-accent scale-x-0 group-hover:scale-x-100 transition-transform origin-left" />
</button>
```

## When Building for NanoClaw

Your output might be used in the `data/workspace/` directory. Check for existing projects:

```bash
ls -la /workspace/
```

Common patterns:
- Landing pages go in `/workspace/landings/`
- Prototypes go in `/workspace/prototypes/`
- Demos go in `/workspace/demos/`

## Quality Checklist

Before finishing, verify:
- [ ] Typography has clear hierarchy (at least 3 distinct sizes)
- [ ] Colors have personality (not generic purple/blue)
- [ ] Layouts break the grid somewhere (asymmetry = interest)
- [ ] Backgrounds have depth (not flat solid colors)
- [ ] Interactive elements have hover/focus states
- [ ] Mobile responsive (check at 375px width)
- [ ] Accessibility: sufficient contrast, focus visible, semantic HTML
- [ ] Performance: no unnecessary re-renders, optimized images

## Example: Landing Page Structure

```tsx
export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 backdrop-blur-md bg-black/20 border-b border-white/5">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <Logo />
          <NavLinks />
          <CTAButton />
        </div>
      </nav>

      {/* Hero */}
      <Hero />

      {/* Features - asymmetric grid */}
      <Features />

      {/* Social proof */}
      <Testimonials />

      {/* CTA section */}
      <CTA />

      {/* Footer */}
      <Footer />
    </div>
  );
}
```

Remember: Good design feels invisible. Great design feels intentional. Make every choice deliberate.
