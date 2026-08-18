trait Renderable {
    type Output;

    fn render(&self, width: usize) -> Self::Output;
}

trait CachedRenderable: Renderable
where
    Self::Output: Clone,
{
    fn render_cached(&self, width: usize) -> Self::Output {
        // The default method combines a bound and a nested call.
        self.render(width).clone()
    }
}

impl<T> CachedRenderable for T
where
    T: Renderable,
    T::Output: Clone,
{
}
