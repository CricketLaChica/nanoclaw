---
name: legislator-site-scraper
description: Scrapes a legislator or campaign website and generates a comprehensive markdown file with all content plus a professional style guide based on the site's colors. Automatically analyzes downloaded images with vision and renames them appropriately.
allowed-tools: Bash, Read, Write, WebFetch, WebSearch
---

# Legislator Site Scraper

Scrapes legislator/campaign websites and generates comprehensive documentation with style guides.

## Quick Start

```bash
# Scrape a legislator website
scrape-site https://www.example-legislator.com
```

## What It Does

1. **Crawls the entire site** - Follows links to capture all pages
2. **Extracts all content** - Text, headings, lists, quotes
3. **Downloads images** - Photos, logos, graphics
4. **Analyzes images with vision** - Identifies content and renames appropriately
5. **Generates style guide** - Extracts colors, fonts, design patterns
6. **Creates markdown output** - Comprehensive documentation

## Output Structure

```
/workspace/scrapes/legislator-name/
├── README.md           # Main content compilation
├── STYLE-GUIDE.md      # Design system documentation
├── images/
│   ├── hero-photo.jpg
│   ├── campaign-logo.png
│   ├── family-photo.jpg
│   └── ...
└── raw/
    └── ...             # Original HTML for reference
```

## Style Guide Contents

The generated style guide includes:
- **Color palette** - Primary, secondary, accent colors with hex codes
- **Typography** - Font families, sizes, weights used
- **Button styles** - Colors, border radius, hover states
- **Spacing patterns** - Margins, padding conventions
- **Visual elements** - Icons, dividers, backgrounds

## Usage Examples

```bash
# Basic scrape
scrape-site https://www.house.gov/member/

# Scrape with custom output directory
scrape-site https://campaign.example.com --output /workspace/my-campaign/

# Scrape with depth limit
scrape-site https://example.com --depth 2
```

## Workflow

1. **Start the scrape:**
   ```bash
   scrape-site https://www.legislator-example.com
   ```

2. **Wait for completion** - Progress is logged to console

3. **Review outputs:**
   - `README.md` - All site content in organized markdown
   - `STYLE-GUIDE.md` - Design system for replication
   - `images/` - Downloaded and renamed assets

4. **Use the style guide** to create matching designs:
   ```tsx
   // Colors from the style guide
   const colors = {
     primary: '#1E3A5F',    // Navy blue from site
     accent: '#C41E3A',     // Red from CTA buttons
     background: '#F5F5F5', // Light gray background
   };
   ```

## Best Practices

- Always check `robots.txt` before scraping
- Be respectful - add delays between requests
- Don't scrape during high-traffic periods
- Use the content for reference, not direct copying
- Attribute sources when using scraped content

## Troubleshooting

**Site blocks scraping:**
```bash
# Add user agent
scrape-site https://example.com --user-agent "Mozilla/5.0..."
```

**Too many pages:**
```bash
# Limit depth
scrape-site https://example.com --depth 1 --max-pages 20
```

**Images not downloading:**
```bash
# Check if images are lazy-loaded or require authentication
scrape-site https://example.com --wait-for-images
```

## Integration with Other Skills

After scraping, use with:
- **frontend-design** - Build a site using the extracted style guide
- **create-lovable-website** - Create a modern version with the same branding
- **redesign-website** - Generate multiple redesign variations
