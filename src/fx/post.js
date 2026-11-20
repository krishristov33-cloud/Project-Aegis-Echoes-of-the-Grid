// Post stack. createPost({ renderer, scene, camera, tuning, bus }) -> { render(dt), resize(w, h), dispose() }.
export function createPost({ renderer, scene, camera }) {
  return { render() { renderer.render(scene, camera); }, resize() {}, dispose() {} };
}
