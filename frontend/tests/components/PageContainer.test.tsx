import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
} from 'react-router-dom';
import PageContainer from '../../src/components/Layout/PageContainer';

function ListPage() {
  return (
    <PageContainer title="List">
      <Link to="/detail">Open detail</Link>
    </PageContainer>
  );
}

function DetailPage() {
  const navigate = useNavigate();
  return (
    <PageContainer title="Detail">
      <button onClick={() => navigate(-1)}>Back</button>
    </PageContainer>
  );
}

function getScrollContainer(): HTMLDivElement {
  return screen.getByRole('heading').parentElement?.parentElement
    ?.parentElement as HTMLDivElement;
}

describe('PageContainer route scroll restoration', () => {
  it('starts pushed detail pages at the top and restores list position on back', async () => {
    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/list', key: 'container-list' }]}
      >
        <Routes>
          <Route path="/list" element={<ListPage />} />
          <Route path="/detail" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const listContainer = getScrollContainer();
    listContainer.scrollTop = 640;
    fireEvent.click(screen.getByRole('link', { name: 'Open detail' }));

    await screen.findByRole('heading', { name: 'Detail' });
    expect(getScrollContainer().scrollTop).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    await screen.findByRole('heading', { name: 'List' });
    await waitFor(() => expect(getScrollContainer().scrollTop).toBe(640));
  });

  it('also restores viewport scrolling used by mobile layouts', async () => {
    const scrollingElement = document.documentElement;
    scrollingElement.scrollTop = 0;

    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/list', key: 'viewport-list' }]}
      >
        <Routes>
          <Route path="/list" element={<ListPage />} />
          <Route path="/detail" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    scrollingElement.scrollTop = 480;
    fireEvent.click(screen.getByRole('link', { name: 'Open detail' }));

    await screen.findByRole('heading', { name: 'Detail' });
    expect(scrollingElement.scrollTop).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    await screen.findByRole('heading', { name: 'List' });
    await waitFor(() => expect(scrollingElement.scrollTop).toBe(480));
    scrollingElement.scrollTop = 0;
  });
});
