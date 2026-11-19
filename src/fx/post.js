// A2 / later: post stack. No-op so the game runs without a composer.
export function createPost() { return { render(renderer, scene, camera) { renderer.render(scene, camera); }, resize() {}, dispose() {} }; }
