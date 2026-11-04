# Walkabout

Plan evenly balanced walking routes for scouts canvassing neighborhoods: for
example, handing out flyers that ask residents to leave food on their porch,
then coming back a week later to collect it.

**Live app:** https://scouting-hb.github.io/Walkabout/

Everything runs in the browser. There is no server and no account.

## How to use it

1. **Draw regions.** Search for your town, click **Draw region** and click the
   corners of each area to cover. Click the first corner (or double-click, or
   press Enter) to finish. Use ✎ to drag corners afterwards. You can also
   import regions from a GeoJSON file.
2. **Add start and end points (optional).**
   - *Pairs*: tick "Starts and ends are pairs" and start 1 goes with end 1,
     start 2 with end 2, and so on (e.g. each family's drop-off and pick-up).
   - *Separate lists*: starts and ends are matched to routes independently.
   - *Fewer points than walkers*: walkers share the nearest point, so a single
     start works for "everyone leaves from the meeting place".
   - *No points*: every route starts and ends wherever suits it best.
3. **Set the number of walkers** (or walking groups) and click **Plan**.

Each route gets a colour, a distance, climb and descent, a rough time, a
street-by-street list, and a GPX download for phone apps. **Print route
sheets** prints one checklist page per walker. Your work is saved in the
browser automatically, and **Save project file** writes a copy you can share.

## How routes are balanced

- Streets come from OpenStreetMap through the Overpass API. By default it covers
  residential, living, unclassified, tertiary and secondary streets that fall
  inside your regions. Other walkable ways are used only for getting around.
- Elevation comes from the Open-Meteo elevation API (Copernicus 90 m DEM).
- *Effort* = metres walked + *N* × metres climbed (*N* = 8 by default, roughly
  Naismith's rule). The planner splits the streets with a balanced k-means,
  matches start/end points to the areas (Hungarian assignment), builds a
  covering walk for each area, and then keeps handing boundary streets from the
  hardest route to a lighter neighbour while that makes the hardest route
  easier.
- Walking between streets and to/from start and end points counts toward
  effort unless you turn that off under *More options*. There you can also
  have both sides of busier roads walked separately.

Solid lines on the map are where to hand out flyers. Dashed lines are just
walking.

## Development

```sh
bun install
bun run dev      # local dev server
bun test         # planner tests
bun run build    # static site in dist/
```

Pushing to `main` builds the site and deploys it to GitHub Pages
(`.github/workflows/deploy.yml`).

Colours come from the den palette in
[Den-Calendar-Composer](https://github.com/Scouting-HB/Den-Calendar-Composer).
Map data © OpenStreetMap contributors.
