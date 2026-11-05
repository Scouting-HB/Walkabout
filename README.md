# Walkabout

Plan evenly balanced walking routes for scouts canvassing neighborhoods: for
example, handing out flyers that ask residents to leave food on their porch,
then coming back a week later to collect it.

**Live app:** https://walkabout.mhciael.com/ (GitHub Pages custom domain; the old scouting-hb.github.io/Walkabout/ address redirects there)

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

### Sharing links

- **🔗 on a walker's card** (or **Copy walker links** for everyone at once)
  makes a link that opens just that walker's route. It shows the route on a map,
  a "show where I am" dot, a street checklist that the phone remembers as they
  tick streets off, and GPX and print buttons. Nothing gets replanned: the link
  carries the route itself, about 2–3 KB for a 13 km route.
- **Share setup link** carries the regions, start and end points and settings,
  so another leader can open them in the planner and plan again.

Both keep their data after the `#` in the URL, so it never reaches a server.

## How routes are balanced

- Streets come from OpenStreetMap through the Overpass API. By default it covers
  residential, living, unclassified, tertiary and secondary streets that fall
  inside your regions. Other walkable ways are used only for getting around.
- Elevation comes from the Copernicus DEM: 30 m resolution from the mirror
  described below, or 90 m from the Open-Meteo API.
- **Mirrors.** For Virginia and its neighbours, the app first tries
  self-hosted mirrors: `overpass.mirror.mhciael.com` (Geofabrik's US South
  extract, roads only, updated hourly) and `elevation.mirror.mhciael.com`
  (OpenTopoData, Copernicus 30 m, lat 33–41° N, lon 75–91° W). Anywhere else,
  or if a mirror is down, it uses the public servers. The mirrors only answer
  pages served from `scouting-hb.github.io`, `walkabout.mhciael.com` or
  `localhost`, and they are rate-limited per visitor. The URLs and coverage are
  set in `src/lib/servers.js`.
- *Effort* = metres walked + *N* × metres climbed (*N* = 8 by default, roughly
  Naismith's rule). The planner splits the streets with a balanced k-means,
  matches start/end points to the areas (Hungarian assignment), builds a
  covering walk for each area, and then keeps handing boundary streets from the
  hardest route to a lighter neighbour while that makes the hardest route
  easier. It repeats this from several different starting splits and keeps the
  most even result.
- Walking between streets and to/from start and end points counts toward
  effort unless you turn that off under *More options*.

### Sides of the street

Every street type is either **criss-cross**, where one pass covers both sides
(fine on quiet residential streets), or **two-sided**, where each side is its
own piece of work. Two-sided pieces are balanced independently, so one walker
may take the north side of a road and another the south side. A walker who
has both sides goes down one side to the end of the street and back up the
other. Walking a side in its preferred direction keeps the houses on the
walker's left, which means facing traffic. Street lists say which side
("Oak St · north side"), and the map draws side passes just off the
centreline. Pick *Criss-cross all*, *Busy roads two-sided* (the default:
tertiary and larger) or *All two-sided*, or mix per street type under
*More options*.

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
