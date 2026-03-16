
import React from 'react';
import { withBasePath } from '../utils/basePath';

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
    href: string;
}

export const Link: React.FC<LinkProps> = ({ href, children, ...props }) => {
    const resolvedHref = withBasePath(href);

    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

        e.preventDefault();
        window.history.pushState({}, '', resolvedHref);
        // Dispatch popstate to trigger re-render in useUrlState
        window.dispatchEvent(new PopStateEvent('popstate'));
    };

    return (
        <a href={resolvedHref} onClick={handleClick} {...props}>
            {children}
        </a>
    );
};
